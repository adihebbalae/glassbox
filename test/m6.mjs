// M6 proof: the ride-along watch channel. Cold-starts the daemon via the CLI, serves the bug-zoo,
// and drives the WS screencast + takeover over the daemon's own control plane. Asserts arch §7:
//   - a WS watcher receives ≥3 binary [len][meta][jpeg] frames during a scripted scroll (driven via
//     the normal action route), with sane meta {w,h} and real JPEG bytes,
//   - a forwarded TAKEOVER click (frame-space CSS coords) lands: the bug-zoo button mutates #result,
//   - a SECOND watcher joins and also receives frames (broadcast), then both disconnect and the
//     screencast refcount stops (journal 'watch/stop' + a follow-up action still works — no error),
//   - PAUSED metadata: a breakpoint pauses the click handler and the next frame carries paused:true,
//   - GET / (grid) and GET /watch/:session (viewer) serve HTML; /sessions/:name exposes the cdp block,
//   - the CLI `watch` verb prints a tokened URL.
// kill-all + zero-orphan at the end. Run: `node test/m6.mjs`.
//
// The paused-trigger click is FIRE-AND-FORGET (a paused handler blocks the CDP input dispatch); we
// poll debug `state` until paused, connect a fresh watcher (whose startScreencast emits a frame while
// the page is frozen), assert paused:true, then resume so the parked click completes.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS, daemonReq } from '../src/protocol.mjs';
import { listGlassboxChromium } from '../src/daemon/prockit.mjs';
import { startBugzoo } from './bugzoo/serve.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args, timeout = 60000) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', timeout, env: { ...process.env, GLASSBOX_NO_OPEN: '1' }, // don't pop a real browser tab
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function readD() { try { return JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8')); } catch { return null; } }
function journalRecords(name) {
  try {
    return fs.readFileSync(path.join(PATHS.sessions, name, 'journal.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  } catch { return []; }
}

// ---- a minimal WS watch client over the hand-rolled server -----------------
function parseFrame(ab) {
  const buf = Buffer.from(ab);
  const metaLen = buf.readUInt32LE(0);
  const meta = JSON.parse(buf.subarray(4, 4 + metaLen).toString('utf8'));
  const jpeg = buf.subarray(4 + metaLen);
  return { meta, jpeg };
}
function connectWatch(port, token, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/watch/${name}?token=${token}`);
  ws.binaryType = 'arraybuffer';
  const frames = [];
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') return;
    try { frames.push(parseFrame(ev.data)); } catch { /* ignore a malformed frame */ }
  });
  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error ' + name)));
    setTimeout(() => reject(new Error('ws open timeout ' + name)), 10000);
  });
  return {
    frames, open,
    send: (o) => { try { ws.send(JSON.stringify(o)); } catch { /* closed */ } },
    close: () => new Promise((r) => { ws.addEventListener('close', () => r()); try { ws.close(); } catch { r(); } }),
    async waitFrames(n, ms = 5000) { const dl = Date.now() + ms; while (frames.length < n && Date.now() < dl) await delay(50); return frames.length; },
  };
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

let zoo;
async function run() {
  zoo = await startBugzoo();
  const base = zoo.base;

  cli(['kill-all']);
  await delay(500);
  check('1 precondition clean', !fs.existsSync(PATHS.daemonFile) && listGlassboxChromium().length === 0,
    `chromium ${listGlassboxChromium().length}`);

  const r2 = cli(['--json', 'session', 'open', 'watch']);
  const d = readD();
  check('2 cold CLI open auto-starts daemon', r2.status === 0 && !!d, `exit=${r2.status}`);
  if (!d) return;
  const post = (s, verb, body, ms) => daemonReq(d, 'POST', `/sessions/${s}/${verb}`, body || {}, ms);
  const act = async (s, verb, body, ms) => (await post(s, verb, body, ms)).body;
  const dbg = (s, body) => act(s, 'debug', body, 60000);

  await act('watch', 'goto', { url: base + '/watch.html' }, 30000);

  // --- a. one watcher, ≥3 frames during a scripted scroll, sane meta + real jpeg ---------------
  const A = connectWatch(d.port, d.token, 'watch');
  await A.open;
  await A.waitFrames(1, 3000); // startScreencast emits the current frame on connect
  const a0 = A.frames.length;
  for (let i = 0; i < 6; i++) { await act('watch', 'scroll', { by: 300 }); await delay(200); }
  check('a1 ≥3 screencast frames arrive during a scripted scroll', A.frames.length >= 3,
    `frames=${A.frames.length} (scrollGained=${A.frames.length - a0})`);
  const fr = A.frames[A.frames.length - 1] || A.frames[0];
  check('a2 frame meta {w,h} sane', fr && fr.meta.w >= 100 && fr.meta.w <= 4000 && fr.meta.h >= 100 && fr.meta.h <= 4000,
    `w=${fr?.meta.w} h=${fr?.meta.h} ts=${fr?.meta.ts}`);
  check('a3 frame payload is real JPEG (SOI marker)', fr && fr.jpeg.length > 200 && fr.jpeg[0] === 0xff && fr.jpeg[1] === 0xd8,
    `bytes=${fr?.jpeg.length} head=${fr ? [fr.jpeg[0], fr.jpeg[1]].map((b) => b.toString(16)).join(' ') : '-'}`);

  // --- b. a forwarded takeover click lands (bug-zoo button mutates #result) --------------------
  A.send({ type: 'click', x: 160, y: 80 }); // frame-space CSS center of the fixed #hit button
  await delay(600);
  const afterClick = await act('watch', 'observe', {});
  check('b takeover click lands: #result mutated to watch-clicked', afterClick.ok && /watch-clicked/.test(afterClick.text || ''),
    `text=${(afterClick.text || '').replace(/\s+/g, ' ').slice(0, 60)}`);

  // --- c. a second watcher also receives frames (broadcast) ------------------------------------
  const B = connectWatch(d.port, d.token, 'watch');
  await B.open;
  const a1 = A.frames.length, b1 = B.frames.length;
  for (let i = 0; i < 4; i++) { await act('watch', 'scroll', { by: 250 }); await delay(200); }
  check('c both watchers receive frames while both connected', A.frames.length > a1 && B.frames.length > b1,
    `A +${A.frames.length - a1}, B +${B.frames.length - b1}`);

  // --- d. disconnect both → screencast refcount stops; session still healthy -------------------
  await A.close();
  await B.close();
  await delay(700);
  const jr = journalRecords('watch');
  const stopped = jr.some((e) => e.event === 'watch' && e.phase === 'stop');
  check('d1 last watcher gone → screencast stopped (journal watch/stop)', stopped,
    `watchEvents=${jr.filter((e) => e.event === 'watch').map((e) => e.phase).join(',')}`);
  const stillOk = await act('watch', 'observe', {});
  check('d2 session stays healthy after all watchers leave (follow-up action ok)', stillOk.ok === true,
    `count=${stillOk.count}`);

  // --- e. PAUSED metadata: breakpoint pauses the handler, next frame carries paused:true --------
  const br = await dbg('watch', { op: 'break', file: 'watch.js', line: 5 });
  check('e1 break resolves in the click handler', br.ok && /watch\.js$/.test(br.file || ''), `file=${br.file} line=${br.line}`);
  const clickP = post('watch', 'click', { selector: '#hit' }, 60000).catch(() => {}); // fire-and-forget → will pause
  let st = { paused: false };
  for (let i = 0; i < 80 && !st.paused; i++) { st = await dbg('watch', { op: 'state' }); if (!st.paused) await delay(100); }
  check('e2 click paused at the breakpoint', st.paused === true, `paused=${st.paused} fn=${st.frames?.[0]?.functionName}`);

  const C = connectWatch(d.port, d.token, 'watch'); // fresh watcher → startScreencast emits a frame of the frozen page
  await C.open;
  await delay(250);
  C.send({ type: 'scroll', x: 100, y: 400, dy: 200 }); // compositor nudge in case the page is fully idle
  await C.waitFrames(1, 4000);
  const pausedFrame = C.frames.some((f) => f.meta.paused === true);
  check('e3 screencast frame reports paused:true while paused', pausedFrame,
    `frames=${C.frames.length} pausedFlags=${C.frames.map((f) => f.meta.paused).join(',')}`);

  const res = await dbg('watch', { op: 'resume' });
  await Promise.race([clickP, delay(8000)]); // the parked click completes
  await C.close();
  check('e4 resume completes', res.resumed === true, `resumed=${res.resumed}`);

  // --- f. HTTP surface: grid + viewer HTML, and the cdp info block ------------------------------
  const gridRes = await fetch(`http://127.0.0.1:${d.port}/?token=${d.token}`);
  const gridHtml = await gridRes.text();
  check('f1 GET / serves the session grid (lists a /watch/ link)', gridRes.status === 200 && /glassbox/.test(gridHtml) && gridHtml.includes('/watch/'),
    `status=${gridRes.status}`);
  const viewRes = await fetch(`http://127.0.0.1:${d.port}/watch/watch?token=${d.token}`);
  const viewHtml = await viewRes.text();
  check('f2 GET /watch/:session serves the viewer (canvas + boot config)', viewRes.status === 200 && /<canvas/i.test(viewHtml) && viewHtml.includes('BOOT'),
    `status=${viewRes.status}`);
  const infoRes = await daemonReq(d, 'GET', '/sessions/watch');
  const hasCdp = infoRes.status === 200 && ('cdp' in infoRes.body);
  const cdpResolved = !!infoRes.body?.cdp?.devtoolsFrontend;
  check('f3 /sessions/:name exposes a cdp block (DevTools link when a debug port is reachable)', hasCdp,
    `cdp=${cdpResolved ? 'resolved' : 'null (degraded — no debug port)'} targetWs=${infoRes.body?.cdp?.targetWs || '-'}`);

  // --- g. CLI watch verb prints a tokened URL --------------------------------------------------
  const cliWatch = cli(['--json', 'watch', 'watch']);
  let watchUrl = '';
  try { watchUrl = JSON.parse(cliWatch.stdout.trim()).url || ''; } catch { /* leave blank */ }
  check('g CLI `watch` prints a tokened /watch/ URL', cliWatch.status === 0 && /\/watch\/watch\?token=/.test(watchUrl),
    `url=${watchUrl.slice(0, 60)}`);

  // --- teardown: zero orphan chromium ----------------------------------------------------------
  const before = listGlassboxChromium().length;
  cli(['--json', 'kill-all']);
  await delay(700);
  const after = listGlassboxChromium().length;
  check('h1 kill-all removes daemon.json', !fs.existsSync(PATHS.daemonFile));
  check('h2 kill-all leaves zero chromium strays', after === 0, `chromium ${before} -> ${after}`);
}

function finish() {
  try { zoo?.close(); } catch { /* already closed */ }
  cli(['kill-all']);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.log('FAIL  harness threw —', e?.stack || e);
  results.push({ name: 'harness', pass: false });
}).finally(finish);
