// LIVE check against a real framework — NOT part of `npm test` (it needs a real project on disk,
// possibly an `npm install`, and it verifies a site nobody controls, so it can never be a gate).
// Run it by hand, pointed at any dev-server project you have, after touching the dev loop or the
// verify engine:
//
//   node test/live-devserver.mjs --cwd <project dir>
//   GLASSBOX_LIVE_CWD=<project dir> npm run test:live
//
// It drives the shipped CLI end to end: `glassbox dev` spawns the project's dev server, discovers
// the ready URL out of that server's own banner (Astro's `┃ Local  http://localhost:4321/`, Vite's
// `➜  Local:`, Next's `- Local:`), attaches the session, runs one verify, then this script takes a
// full-page screenshot and stops the whole tree. The PASS/FAIL gates are the mechanics — URL
// discovery, attach, verify completion, screenshot on disk, clean shutdown, zero orphans. The
// FINDINGS are reported, never gated: a real site's ok:false is information about the site, not a
// failure of the tool.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS, daemonReq } from '../src/protocol.mjs';
import { listGlassboxChromium, processAlive } from '../src/daemon/prockit.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Candidates, first one holding a package.json wins: an explicit --cwd, then GLASSBOX_LIVE_CWD.
// There is no default — this test needs a project you control, so it says so rather than guessing.
const argCwd = (() => { const i = process.argv.indexOf('--cwd'); return i > 0 ? process.argv[i + 1] : null; })();
const CANDIDATES = [
  argCwd,
  process.env.GLASSBOX_LIVE_CWD,
].filter(Boolean);
if (!CANDIDATES.length) {
  console.error('live: no project given. Pass --cwd <dir> or set GLASSBOX_LIVE_CWD to a directory');
  console.error('live: with a package.json and a `dev` script (Astro, Vite, Next, … all work).');
  process.exit(2);
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function cli(args, timeout = 60000) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout, env: { ...process.env, GLASSBOX_NO_OPEN: '1' } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function readD() { try { return JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8')); } catch { return null; } }

/** Spawn the streaming `glassbox dev --json` and collect its event lines as they arrive. */
function spawnDev(args) {
  const child = spawn(process.execPath, [CLI, 'dev', '--json', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GLASSBOX_NO_OPEN: '1' },
  });
  const events = [];
  const state = { out: '', err: '' };
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    state.out += c;
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* not an event line */ }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { state.err += c; });
  const exit = new Promise((r) => child.on('exit', (code) => r(code)));
  return {
    child, exit, events, state,
    async waitFor(event, ms) {
      const dl = Date.now() + ms;
      while (Date.now() < dl) {
        const e = events.find((x) => x.event === event);
        if (e) return e;
        await delay(200);
      }
      return null;
    },
  };
}

let dev = null;
async function run() {
  const cwd = CANDIDATES.find((c) => { try { return fs.existsSync(path.join(c, 'package.json')); } catch { return false; } });
  check('0 a real project with a package.json was found', !!cwd, `tried: ${CANDIDATES.join(' | ')}`);
  if (!cwd) return;
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  console.log(`\n[live] project: ${cwd}\n[live] dev script: ${JSON.stringify(pkg.scripts?.dev)}\n`);

  if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
    console.log('[live] node_modules missing — running npm install (this can take minutes)…');
    const t0 = Date.now();
    const inst = spawnSync('npm', ['install'], { cwd, encoding: 'utf8', shell: true, timeout: 15 * 60 * 1000 });
    console.log(`[live] npm install exited ${inst.status} in ${Math.round((Date.now() - t0) / 1000)}s`);
    if (inst.status !== 0) console.log((inst.stderr || '').split('\n').slice(-15).join('\n'));
  }
  check('1 dependencies are installed', fs.existsSync(path.join(cwd, 'node_modules')), path.join(cwd, 'node_modules'));

  cli(['kill-all']);
  await delay(500);

  // ---- the real dev loop ----------------------------------------------------
  const t0 = Date.now();
  dev = spawnDev(['--cwd', cwd, '--session', 'wcii', '--timeout', '120']);

  const ready = await dev.waitFor('ready', 150000);
  check('2 URL discovered from the real Astro banner', !!ready && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(ready.url || ''),
    ready ? `${ready.url}  (${Math.round((Date.now() - t0) / 1000)}s)` : `no ready event — stderr tail: ${dev.state.err.split('\n').slice(-6).join(' / ').slice(0, 300)}`);
  if (!ready) return;

  const attached = await dev.waitFor('attached', 90000);
  check('3 session attached to the live dev server', !!attached && attached.session === 'wcii',
    attached ? `session=${attached.session} reused=${attached.reused}` : 'no attach event');

  const v = await dev.waitFor('verify', 180000);
  check('4 verify completed against the real site', !!v && !!v.counts, v ? `ok=${v.ok} ${JSON.stringify(v.counts)}` : 'no verify event');

  // ---- report (never gate) --------------------------------------------------
  let full = null;
  if (v?.report) { try { full = JSON.parse(fs.readFileSync(v.report, 'utf8')); } catch { /* keep null */ } }
  console.log('\n================ LIVE WCII FINDINGS (reported, not gated) ================');
  console.log(`url: ${full?.url || ready.url}`);
  console.log(`ok: ${v?.ok}   settled: ${full?.settled}${full?.settleWhy?.length ? ` (why: ${full.settleWhy.join(',')})` : ''}`);
  console.log(`counts: ${JSON.stringify(v?.counts)}`);
  const findings = full?.findings || v?.findings || [];
  console.log(`findings: ${findings.length}`);
  findings.slice(0, 12).forEach((f, i) => console.log(`  ${i + 1}. [${f.severity}/${f.channel}] ${String(f.summary).replace(/\s+/g, ' ').slice(0, 220)}`));
  console.log(`report: ${v?.report}`);
  console.log('=========================================================================\n');

  // ---- artifacts against the live session -----------------------------------
  const d = readD();
  let shot = null;
  let overlay = null;
  if (d) {
    shot = (await daemonReq(d, 'POST', '/sessions/wcii/screenshot', { fullPage: true }, 60000).catch(() => ({ body: {} }))).body;
    overlay = (await daemonReq(d, 'POST', '/sessions/wcii/read', { channel: 'overlay' }, 30000).catch(() => ({ body: {} }))).body;
  }
  check('5 full-page screenshot written to the session artifact dir',
    !!shot?.path && fs.existsSync(shot.path) && shot.bytes > 0,
    shot?.path ? `${shot.path} (${shot.bytes}b, ${shot.w}x${shot.h})` : 'no screenshot');
  check('6 no build-error overlay on the healthy dev server', overlay?.ok === true && overlay.overlay === null,
    `overlay=${JSON.stringify(overlay?.overlay)}`);

  // ---- clean shutdown -------------------------------------------------------
  const devPid = Number((/"pid":(\d+)/.exec(JSON.stringify(ready)) || [])[1]) || 0;
  dev.child.stdin.write('q\n');
  const code = await Promise.race([dev.exit, delay(30000).then(() => 'timeout')]);
  await delay(1000);
  check('7 q + Enter stops the dev server cleanly', code === 0 && (!devPid || !processAlive(devPid)),
    `exit=${code} devPid=${devPid} alive=${devPid ? processAlive(devPid) : 'n/a'}`);

  const before = listGlassboxChromium().length;
  cli(['--json', 'kill-all']);
  await delay(900);
  check('8 kill-all leaves zero chromium orphans and no daemon.json',
    listGlassboxChromium().length === 0 && !fs.existsSync(PATHS.daemonFile), `chromium ${before} -> ${listGlassboxChromium().length}`);
}

function finish() {
  try { dev?.child.kill(); } catch { /* already gone */ }
  cli(['kill-all']);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.log('FAIL  harness threw —', e?.stack || e);
  results.push({ name: 'harness', pass: false });
}).finally(finish);
