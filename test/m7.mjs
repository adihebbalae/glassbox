// M7 proof: the dev-loop bridge (`glassbox dev`). Drives the real CLI against a throwaway
// dev server (test/fixtures/fake-dev-server.mjs — no npm install, no framework) and asserts:
//   - the pure discovery helpers: a real ANSI-colored Vite banner yields the localhost URL, a
//     non-URL banner line yields nothing, and the HMR line is recognized as a rebuild,
//   - `--no-attach`: the URL is discovered from the child's own stdout, printed, and the CLI exits
//     0 having taken the dev tree down with it (no fixture process survives),
//   - attached: URL discovered → session 'dev' exists in the daemon → the first verify ran (report
//     on disk, ok:true on the clean fixture page — the false-positive check) → watch URL printed,
//   - POST /rebuild → the CLI prints "rebuild detected", journals {event:'rebuild'} to the session,
//     and the seeded build error is captured through `read overlay` (open shadow DOM) within 10s,
//     and printed by the streaming loop,
//   - Ctrl-C equivalent (q + Enter on stdin): the CLI exits 0 and the whole dev tree is dead,
//   - the force-kill backstop: a dev record whose owner PID is gone is reaped by `kill-all`, and
//     only after its command line re-verifies (PID-reuse safety).
// kill-all + zero-orphan check at the end. Run: `node test/m7.mjs`.
//
// Every child here is a real process (never an in-process server alongside spawnSync), and the
// streaming CLI is driven asynchronously — spawnSync is used only when nothing is streaming.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS, daemonReq } from '../src/protocol.mjs';
import { listGlassboxChromium, commandLineFor, processAlive } from '../src/daemon/prockit.mjs';
import { findUrl, isRebuildLine } from '../src/dev.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-dev-server.mjs', import.meta.url));
const DEV_CMD = `node "${FIXTURE}"`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// The dev tree is two processes on win32: the shell `glassbox dev` spawned (whose PID it prints)
// and the fixture node under it (which announces its own PID). Both are tracked explicitly —
// research 07 §5: an explicit PID list is cheaper and more reliable than tree discovery.
const treePids = (d) => [
  Number((/\(pid (\d+)\)/.exec(d.state.out) || [])[1]) || 0,
  Number((/\[fixture\] pid (\d+)/.exec(d.state.err) || [])[1]) || 0,
].filter(Boolean);
const aliveOf = (pids) => pids.filter((p) => processAlive(p));

function cli(args, timeout = 60000) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout, env: { ...process.env, GLASSBOX_NO_OPEN: '1' } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function readD() { try { return JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8')); } catch { return null; } }
function journalRecords(name) {
  try {
    return fs.readFileSync(path.join(PATHS.sessions, name, 'journal.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  } catch { return []; }
}

/** Spawn `glassbox dev …` as a live child and accumulate its two streams. */
function spawnDev(args) {
  const child = spawn(process.execPath, [CLI, 'dev', ...args], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GLASSBOX_NO_OPEN: '1' },
  });
  const state = { out: '', err: '' };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { state.out += c; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { state.err += c; });
  const exit = new Promise((r) => child.on('exit', (code) => r(code)));
  return {
    child, exit, state,
    async until(re, ms = 90000) {
      const dl = Date.now() + ms;
      while (Date.now() < dl) { if (re.test(state.out)) return true; await delay(150); }
      return false;
    },
  };
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

let dev = null;
async function run() {
  cli(['kill-all']);
  await delay(500);
  check('1 precondition clean', !fs.existsSync(PATHS.daemonFile) && listGlassboxChromium().length === 0,
    `chromium ${listGlassboxChromium().length}`);

  // --- u. the pure discovery helpers (no browser, no daemon) -----------------
  const ESC = String.fromCharCode(27);
  const viteBanner = `  ${ESC}[32m->${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:5173/${ESC}[39m`;
  check('u1 findUrl pulls the URL out of a real ANSI-colored Vite banner', findUrl(viteBanner) === 'http://localhost:5173/',
    `got=${JSON.stringify(findUrl(viteBanner))}`);
  check('u2 findUrl ignores the non-URL banner line; isRebuildLine spots the HMR line only',
    findUrl(`  ${ESC}[32mVITE v6.0.0${ESC}[39m  ready in 312 ms`) === '' &&
    isRebuildLine(`${ESC}[36m8:01:23 PM${ESC}[39m [vite] hmr update /src/App.jsx updated in 123ms`) &&
    !isRebuildLine('  Local:   http://127.0.0.1:5173/'),
    `noUrl=${JSON.stringify(findUrl('VITE v6.0.0  ready in 312 ms'))}`);

  // --- a. --no-attach: discover, print, exit, leave nothing behind -----------
  const na = spawnDev(['--cmd', DEV_CMD, '--cwd', ROOT, '--no-attach', '--timeout', '30']);
  const naCode = await Promise.race([na.exit, delay(45000).then(() => 'timeout')]);
  const naUrl = (/dev server ready[^h]*(http:\/\/\S+)/.exec(na.state.out) || [])[1] || '';
  check('a1 --no-attach discovers the ready URL from the child\'s own stdout and exits 0',
    naCode === 0 && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(naUrl), `exit=${naCode} url=${naUrl || '(none)'}`);
  await delay(500);
  const naTree = treePids(na);
  check('a2 --no-attach takes the dev tree down with it', naTree.length === 2 && aliveOf(naTree).length === 0,
    `tree=${naTree.join(',')} alive=${aliveOf(naTree).join(',') || 'none'}`);

  // --- b. attached: session + first verify -----------------------------------
  dev = spawnDev(['--cmd', DEV_CMD, '--cwd', ROOT, '--session', 'dev', '--timeout', '60']);
  const sawReady = await dev.until(/dev server ready/, 60000);
  const url = (/dev server ready[^h]*(http:\/\/\S+)/.exec(dev.state.out) || [])[1] || '';
  check('b1 attached run discovers the URL', sawReady && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(url), `url=${url || '(none)'}`);
  const sawWatch = await dev.until(/session 'dev' attached — watch: http:\/\/127\.0\.0\.1:\d+\/watch\/dev\?token=/, 90000);
  check('b2 session attached and a tokened watch URL printed', sawWatch,
    `line=${(/session 'dev'[^\n]*/.exec(dev.state.out) || ['(none)'])[0].slice(0, 80)}`);

  const d = readD();
  check('b3 daemon has the session (auto-started by `glassbox dev`)', !!d, `daemon=${!!d}`);
  if (!d) return;
  const sessions = (await daemonReq(d, 'GET', '/sessions')).body?.sessions || [];
  const devSession = sessions.find((s) => s.name === 'dev');
  check('b4 session \'dev\' is live and sitting on the dev-server URL', !!devSession && devSession.url.startsWith(url),
    `sessions=${sessions.map((s) => s.name).join(',')} url=${devSession?.url}`);

  const sawVerify = await dev.until(/verify (OK|ISSUES)/, 120000);
  const verifyLine = (/\[glassbox\] verify [^\n]*/.exec(dev.state.out) || ['(none)'])[0];
  const reportPath = ((/report: (.+)/.exec(dev.state.out) || [])[1] || '').trim();
  check('b5 the first verify ran automatically on attach (report written to disk)',
    sawVerify && !!reportPath && fs.existsSync(reportPath), `report=…${reportPath.slice(-30)}`);
  check('b6 verify is ok:true on the clean fixture page (no false-positive flood)', /verify OK/.test(dev.state.out),
    verifyLine.slice(0, 110));

  // --- c. rebuild → journal + overlay ----------------------------------------
  const beforeRebuild = journalRecords('dev').length;
  const trig = await fetch(new URL('/rebuild', url), { method: 'POST' }).then((r) => r.status).catch((e) => String(e));
  check('c0 rebuild trigger accepted by the dev server', trig === 200, `status=${trig}`);

  const sawRebuild = await dev.until(/rebuild detected/, 15000);
  check('c1 the streaming loop reports the rebuild', sawRebuild,
    `line=${(/\[glassbox\] rebuild[^\n]*/.exec(dev.state.out) || ['(none)'])[0].slice(0, 80)}`);

  let jr = [];
  for (let i = 0; i < 40; i++) { jr = journalRecords('dev'); if (jr.some((e) => e.event === 'rebuild')) break; await delay(250); }
  const rebuildRec = jr.find((e) => e.event === 'rebuild');
  check('c2 the rebuild is journaled to the session', !!rebuildRec && /hmr update/.test(rebuildRec.line || ''),
    `journal +${jr.length - beforeRebuild} events, line=${(rebuildRec?.line || '').slice(0, 60)}`);

  let overlay = null;
  const dl = Date.now() + 10000;
  while (Date.now() < dl && !overlay) {
    const r = await daemonReq(d, 'POST', '/sessions/dev/read', { channel: 'overlay' }, 20000).catch(() => ({ body: {} }));
    overlay = r.body?.overlay || null;
    if (!overlay) await delay(500);
  }
  check('c3 `read overlay` extracts the seeded build error out of the open shadow root (≤10s)',
    !!overlay && /GBX-SEED-OVERLAY/.test(overlay.message || '') && /App\.jsx/.test(overlay.file || ''),
    `framework=${overlay?.framework} file=${overlay?.file} msg=${(overlay?.message || '(none)').slice(0, 60)}`);

  const sawOverlayLine = await dev.until(/BUILD ERROR .*GBX-SEED-OVERLAY/, 15000);
  check('c4 the streaming loop surfaces the overlay error itself', sawOverlayLine,
    `line=${(/\[glassbox\] BUILD ERROR[^\n]*/.exec(dev.state.out) || ['(none)'])[0].slice(0, 100)}`);

  // --- d. Ctrl-C equivalent: the whole dev tree dies with the CLI -------------
  const tree = treePids(dev);
  const aliveBefore = aliveOf(tree);
  dev.child.stdin.write('q\n');
  const devCode = await Promise.race([dev.exit, delay(20000).then(() => 'timeout')]);
  await delay(600);
  const aliveAfter = aliveOf(tree);
  check('d1 q + Enter stops the CLI cleanly (exit 0)', devCode === 0, `exit=${devCode}`);
  check('d2 the dev child tree is dead — no orphan node processes from the fixture',
    tree.length === 2 && aliveBefore.length === 2 && aliveAfter.length === 0,
    `tree=${tree.join(',')} alive ${aliveBefore.length} -> ${aliveAfter.length}`);
  check('d3 the dev record file is cleaned up', !fs.existsSync(path.join(PATHS.root, 'dev', `${dev.child.pid}.json`)),
    `record=${path.join(PATHS.root, 'dev', `${dev.child.pid}.json`)}`);

  // --- e. force-kill backstop: kill-all reaps an orphaned dev server ----------
  // Simulates the one case a graceful stop cannot cover: `glassbox dev` itself force-killed
  // (TerminateProcess runs no cleanup on Windows). The record's owner PID is dead, so kill-all
  // must reap the recorded tree — but only after its command line re-verifies.
  const marker = spawn(process.execPath, ['-e', 'setInterval(function(){}, 1000) /* gbx-m7-orphan */'], { detached: true, stdio: 'ignore' });
  marker.unref();
  await delay(500);
  const markerCmdline = commandLineFor(marker.pid);
  const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const deadPid = dead.pid;
  await new Promise((r) => dead.on('exit', r));
  const recFile = path.join(PATHS.root, 'dev', `${deadPid}.json`);
  fs.mkdirSync(path.join(PATHS.root, 'dev'), { recursive: true });
  fs.writeFileSync(recFile, JSON.stringify({ cliPid: deadPid, pid: marker.pid, cmdline: markerCmdline, cmd: 'orphan-sim', ts: Date.now() }));

  // --- teardown: one kill-all covers the backstop AND the orphan sweep --------
  const before = listGlassboxChromium().length;
  const ka = cli(['--json', 'kill-all']);
  await delay(800);
  const after = listGlassboxChromium().length;
  check('e1 kill-all reaps an orphaned dev server (owner PID gone, cmdline re-verified)',
    !processAlive(marker.pid) && !fs.existsSync(recFile) && /"devOrphans":1/.test(ka.stdout),
    `alive=${processAlive(marker.pid)} record=${fs.existsSync(recFile)} out=${ka.stdout.trim().slice(0, 90)}`);
  check('f1 kill-all removes daemon.json', !fs.existsSync(PATHS.daemonFile));
  check('f2 kill-all leaves zero chromium strays', after === 0, `chromium ${before} -> ${after}`);
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
