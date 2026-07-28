// `glassbox dev` — the dev-loop bridge (M7). Spawns your dev command, regexes its output for the
// ready URL, attaches a session, runs one verify, then keeps streaming: every rebuild-ish line
// journals a `rebuild` event and re-reads the build-error overlay through the M3 reader.
//
// Research 07 is binding here. §1: a framework's HMR socket is an INTERNAL client↔server channel
// (one `vite.config` edit from breaking, absent entirely in Next) — never a dependency; rebuild
// awareness is derived from the stdout the server already prints. §3: config parsing can't tell you
// the bound port (Vite silently increments), so stdout-regex for the ready banner is the only
// cross-framework signal — the same approach Playwright's `webServer` ships.
//
// CLI-ONLY BY DESIGN: the MCP surface is capped at 14 tools (research 04 token discipline), so the
// dev loop is a shell command an agent runs via Bash while its verification still lands in the same
// named session every gb_* tool can reach.
//
// WINDOWS LIFECYCLE (research 07 §5): the dev tree dies by `taskkill /T /F`. A force-killed CLI can
// run no cleanup at all, so each spawn is also recorded under %LOCALAPPDATA%\glassbox\dev\ and
// `glassbox kill-all` reaps records whose owner is gone — identity re-derived from the OS (command
// line) at the moment of the kill, never trusted from the file.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, CODES, gbErr, ensureDaemon, daemonReq } from './protocol.mjs';
import { taskkillTree, commandLineFor, processAlive } from './daemon/prockit.mjs';

// Every timer here is unref'd: these are races someone else usually wins (the URL arrives, the
// child exits), and a lingering ref'd timer would hold the CLI open long after the dev tree is
// already dead — indistinguishable from a hang. The child's stdio keeps the loop alive while it
// actually matters.
const delay = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const enc = encodeURIComponent;

// The ready banner. Vite/Astro/Next/CRA/Angular all print a loopback URL; FIRST match wins (the
// "Network:" line, when present, always comes second).
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1?\])[:\d/]\S*/;
// Rebuild-ish chatter — deliberately loose, and purely advisory: it gates nothing, it nudges.
const REBUILD_RE = /(hmr|rebuilt|reload|compiled|updated in|page reload)/i;
// CSI + OSC escapes: dev banners are heavily colored, so strip before matching anything.
const ANSI_RE = /\x1B\[[0-9;?]*[ -\/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;

const REBUILD_DEBOUNCE_MS = 2000; // let the server finish writing before we look at the page
const OVERLAY_POLL_MS = 8000;     // …then poll the overlay this long before calling it clean

export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

/** First loopback URL on a line of dev-server output, ANSI-stripped and de-punctuated, or ''. */
export function findUrl(line) {
  const m = URL_RE.exec(stripAnsi(line));
  return m ? m[0].replace(/[)\]}>.,;'"]+$/, '') : '';
}

/** Does this output line look like a rebuild/HMR/reload event? */
export const isRebuildLine = (line) => REBUILD_RE.test(stripAnsi(line));

/** Default command: whatever `npm run` would do in --cwd. package.json is a hint, never the port. */
function defaultCmd(cwd) {
  let scripts = {};
  try { scripts = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts || {}; } catch { /* none */ }
  if (scripts.dev) return 'npm run dev';
  if (scripts.start) return 'npm run start';
  throw gbErr(CODES.BAD_REQUEST, `no \`dev\` or \`start\` script in ${path.join(cwd, 'package.json')}`, {
    field: 'cmd',
    correction_hint: 'pass --cmd "your dev command" (and --cwd <project dir> if it is not here)',
  });
}

// ---- dev-child bookkeeping (the orphan backstop) ----------------------------

const DEV_DIR = path.join(PATHS.root, 'dev');
const recordPath = (cliPid) => path.join(DEV_DIR, `${cliPid}.json`);

/**
 * Kill a whole process tree. Both platforms now go through prockit's taskkillTree — `taskkill /T /F`
 * on win32, a /proc descendant walk (leaves first, then the process group as a backstop) on POSIX.
 *
 * The POSIX path used to be a bare `kill(-pid)`. A dev server run through `shell:true` can leave a
 * grandchild outside the group — m7 caught exactly one survivor — and a reaper that misses one node
 * process leaves a port bound, which the NEXT run reports as "your dev server is already running".
 */
function killTree(pid) {
  if (!pid) return false;
  return taskkillTree(pid);
}

function writeDevRecord(rec) {
  try {
    fs.mkdirSync(DEV_DIR, { recursive: true });
    fs.writeFileSync(recordPath(rec.cliPid), JSON.stringify(rec));
  } catch { /* the record is a backstop, never a requirement */ }
}
const clearDevRecord = (cliPid) => { try { fs.unlinkSync(recordPath(cliPid)); } catch { /* gone */ } };

/**
 * Reap dev servers whose `glassbox dev` died without cleaning up (a Windows force-kill has no
 * hook). Only records whose OWNER pid is gone are touched, and only when the recorded process's
 * command line still matches the one we spawned — PID reuse must never make us kill a stranger
 * (research 07 §9). Returns the number of trees killed. Called by `glassbox kill-all`.
 */
export function sweepDevOrphans() {
  let files = [];
  try { files = fs.readdirSync(DEV_DIR); } catch { return 0; }
  let killed = 0;
  for (const f of files) {
    const p = path.join(DEV_DIR, f);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* corrupt → drop it */ }
    if (rec && rec.cliPid && processAlive(rec.cliPid)) continue; // a live `glassbox dev` owns it
    if (rec && rec.pid && rec.cmdline && commandLineFor(rec.pid) === rec.cmdline) {
      killTree(rec.pid);
      killed++;
    }
    try { fs.unlinkSync(p); } catch { /* gone */ }
  }
  return killed;
}

// ---- the verb ---------------------------------------------------------------

/** Wrap a daemon error body as a throwable carrying the structured `.gb` shape. */
function wire(body) {
  const gb = body?.error || { code: CODES.INTERNAL, message: 'daemon request failed' };
  return Object.assign(new Error(gb.message || 'daemon request failed'), { gb });
}

/**
 * Run `glassbox dev`. Resolves when the dev server exits or is stopped; throws a structured error
 * (`.gb`) the CLI turns into an exit. `--timeout` is SECONDS here (it is milliseconds on the action
 * verbs) because that is what a dev-server startup budget is naturally expressed in.
 */
export async function runDev(opts = {}, json = false) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const cmd = opts.cmd || defaultCmd(cwd);
  const secs = Number(opts.timeoutMs ?? opts.timeout ?? 60);
  const timeoutMs = (Number.isFinite(secs) && secs > 0 ? secs : 60) * 1000;
  const name = opts.session || process.env.GLASSBOX_SESSION || 'dev';

  const say = (obj, human) => console.log(json ? JSON.stringify(obj) : human);
  const line = (human) => { if (!json) console.log(human); };
  const note = (s) => { try { process.stderr.write(`[dev] ${s}\n`); } catch { /* pipe gone */ } };

  const tail = [];          // last 20 output lines — the payload of the no-URL error
  let url = '';
  let watching = false;     // rebuild detection is armed only after the first verify
  let exited = false;
  let exitCode = null;
  let stopping = false;
  let burstTimer = null;
  let onUrl = () => {};
  let onRebuild = () => {};
  let done = () => {};
  const finished = new Promise((r) => { done = r; });

  const child = spawn(cmd, {
    shell: true,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32', // POSIX: own process group so kill(-pid) reaches the tree
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' },
  });

  function handleLine(raw) {
    note(raw);
    tail.push(raw);
    if (tail.length > 20) tail.shift();
    if (!url) {
      const u = findUrl(raw);
      if (u) { url = u; onUrl(u); }
      return;
    }
    if (watching && REBUILD_RE.test(stripAnsi(raw))) onRebuild(raw);
  }
  // One buffer per stream (stdout and stderr interleave arbitrarily; their lines must not).
  function feed() {
    let buf = '';
    return (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
      }
      if (buf.length > 8192) { handleLine(buf); buf = ''; } // a server that never emits a newline
    };
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', feed());
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', feed());
  child.on('error', (e) => { note(`spawn failed: ${e?.message || e}`); exited = true; done(-1); });
  child.on('exit', (code, sig) => { exited = true; exitCode = code ?? (sig ? -1 : 0); done(exitCode); });

  async function stop(reason) {
    if (stopping) return;
    stopping = true;
    clearTimeout(burstTimer);
    burstTimer = null;
    if (!exited) {
      say({ event: 'stopped', reason, pid: child.pid }, `[glassbox] stopping dev server (pid ${child.pid}) — ${reason}`);
      killTree(child.pid);
    }
    clearDevRecord(process.pid);
    setTimeout(() => done(exitCode ?? 0), 5000).unref?.(); // never hang on a stubborn tree
  }

  // Cleanup hooks. On win32 a hard kill of THIS process runs none of them — that is what the
  // %LOCALAPPDATA%\glassbox\dev record + kill-all sweep above exist for.
  process.on('exit', () => {
    if (!exited) { try { killTree(child.pid); } catch { /* best effort */ } }
    clearDevRecord(process.pid);
  });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(s, () => { stop(`signal ${s}`); });

  // ---- discovery: regex the banner, or fail with the tail --------------------
  const ready = new Promise((r) => { onUrl = r; });
  const found = await Promise.race([ready, delay(timeoutMs).then(() => ''), finished.then(() => '')]);
  if (!found) {
    const why = exited
      ? `dev command exited (code ${exitCode}) before printing a ready URL`
      : `dev command printed no ready URL within ${Math.round(timeoutMs / 1000)}s`;
    await stop('no ready URL');
    if (!json) {
      console.error(`[glassbox] ${why} — last ${tail.length} line(s):`);
      for (const l of tail) console.error(`[dev] ${l}`);
    }
    throw gbErr(CODES.DEV_NO_URL, `${why} — cmd: ${cmd}`, {
      field: 'cmd',
      correction_hint: 'run the command standalone to see it print a URL, raise --timeout, or pass --cmd explicitly',
      output: tail.slice(),
    });
  }

  writeDevRecord({ cliPid: process.pid, pid: child.pid, cmdline: commandLineFor(child.pid), cmd, cwd, url, ts: Date.now() });
  say({ event: 'ready', url, pid: child.pid, cmd, cwd }, `[glassbox] dev server ready → ${url}  (pid ${child.pid})`);

  if (opts.noAttach) { // discover-only: print the URL, take the tree down, leave no session
    await stop('no-attach');
    await Promise.race([finished, delay(5000)]);
    return;
  }

  // ---- attach: session → goto → one verify (no sweeps) -----------------------
  const sayVerify = (r) => {
    const c = r.counts || {};
    say(
      { event: 'verify', ok: r.ok, counts: c, report: r.artifacts?.report ?? null, findings: (r.findings || []).slice(0, 5) },
      `[glassbox] verify ${r.ok ? 'OK' : 'ISSUES'} — consoleErrors=${c.consoleErrors} pageerr=${c.pageErrors} ` +
      `net(failed=${c.netFailed} http=${c.netHttpError} hang=${c.netHanging}) a11y=${c.a11y} layout=${c.layout}`
    );
    for (const f of (r.findings || []).slice(0, 5)) line(`[glassbox]   [${f.severity}/${f.channel}] ${f.summary}`);
    if (r.artifacts?.report) line(`[glassbox]   report: ${r.artifacts.report}`);
  };

  let d;
  try {
    d = await ensureDaemon();
    const open = await daemonReq(d, 'POST', '/sessions', { name }, 60000);
    const reused = open.status === 409 && open.body?.error?.code === CODES.DUP_SESSION;
    if (open.status !== 200 && !reused) throw wire(open.body);
    const watchUrl = `http://127.0.0.1:${d.port}/watch/${enc(name)}?token=${d.token}`;
    say({ event: 'attached', session: name, reused, watchUrl },
      `[glassbox] session '${name}' ${reused ? 'reused' : 'attached'} — watch: ${watchUrl}`);

    const g = await daemonReq(d, 'POST', `/sessions/${enc(name)}/goto`, { url }, 60000);
    if (g.status !== 200) throw wire(g.body);
    const v = await daemonReq(d, 'POST', `/sessions/${enc(name)}/verify`, {}, 120000);
    if (v.status !== 200) throw wire(v.body);
    sayVerify(v.body);
  } catch (e) {
    await stop('attach failed');
    throw e;
  }

  // ---- watch: rebuild → journal → overlay (→ optional verify) ----------------
  const journalEvent = async (event, data) => {
    try { await daemonReq(d, 'POST', `/sessions/${enc(name)}/journal`, { event, data }, 10000); }
    catch { /* journaling must never take down the loop */ }
  };
  const pollOverlay = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        const r = await daemonReq(d, 'POST', `/sessions/${enc(name)}/read`, { channel: 'overlay' }, 15000);
        if (r.status === 200 && r.body?.overlay) return r.body.overlay;
      } catch { /* daemon busy — keep trying until the deadline */ }
      await delay(500);
    }
    return null;
  };
  async function afterRebuild() {
    const ov = await pollOverlay(OVERLAY_POLL_MS);
    if (ov) {
      const file = ov.file ? `  (${String(ov.file).split('\n')[0].trim()})` : '';
      say({ event: 'overlay', overlay: ov },
        `[glassbox] BUILD ERROR [${ov.framework}] ${String(ov.message).replace(/\s+/g, ' ').slice(0, 300)}${file}`);
    }
    if (opts.autoVerify) {
      const v = await daemonReq(d, 'POST', `/sessions/${enc(name)}/verify`, {}, 120000);
      if (v.status === 200) sayVerify(v.body);
    }
  }

  onRebuild = (raw) => {
    if (burstTimer) return; // coalesce a burst of HMR lines into one check
    const text = stripAnsi(raw).trim().slice(0, 300);
    say({ event: 'rebuild', line: text }, `[glassbox] rebuild detected — run 'glassbox verify -s ${name}' to re-check`);
    journalEvent('rebuild', { line: text, url });
    burstTimer = setTimeout(() => { burstTimer = null; afterRebuild().catch((e) => note(`rebuild check failed: ${e?.message || e}`)); }, REBUILD_DEBOUNCE_MS);
    burstTimer.unref?.();
  };
  watching = true;
  say({ event: 'watching', session: name, autoVerify: !!opts.autoVerify },
    `[glassbox] watching for rebuilds — press q + Enter (or Ctrl-C) to stop the dev server`);

  // Ctrl-C is unreliable across parents on Windows (research 07 §5), so stdin is the portable stop
  // channel: 'q' or EOF. Armed only now — a non-interactive parent's already-closed stdin must not
  // shut us down before the session is even attached. unref'd so it never holds the process open.
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { if (/^\s*(q|quit|stop|exit)\b/i.test(chunk)) stop('quit'); });
    process.stdin.on('end', () => stop('stdin closed'));
    process.stdin.resume();
    process.stdin.unref?.();
  } catch { /* no stdin — signals still work */ }

  await finished;
  clearTimeout(burstTimer);
  clearDevRecord(process.pid);
  try { process.stdin.pause(); } catch { /* already gone */ }
  if (!stopping) say({ event: 'exited', code: exitCode }, `[glassbox] dev server exited (code ${exitCode})`);
}
