// M11 proof: defect round 3 (the WCII villas-on-rio dogfood,
// docs/defects-2026-07-25-wcii-dogfood.md). As in m9/m10, every check FAILS on the pre-fix build
// (verified by stashing src/ at 21a0878 and running this file: W5a/W5b/W5c/W6a/W6b/W6c/W6d all red).
//
//   W5  interactive content in a CLOSED <details> is progressive disclosure, not invisibility:
//       one collapsed info line per widget, zero pathology, and never labelled "content-visibility"
//       — plus the honesty fallback when nothing in the DOM ancestor chain explains a hide
//   W6  a clipped (selector) capture is framed in PAGE coordinates and force-paints first, so it
//       survives any scroll — and a featureless clip of a visible element is flagged, never
//       handed back as a silent blank
//
// The bug zoo runs as a CHILD PROCESS (the M5/M7 deadlock lesson). Run: `node test/m11.mjs`.
process.env.GLASSBOX_SETTLE_CAP_MS = '2500';

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS, daemonReq } from '../src/protocol.mjs';
import { listGlassboxChromium, processAlive } from '../src/daemon/prockit.mjs';
import { blankFloorBytes } from '../src/daemon/extras.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const SERVE = fileURLToPath(new URL('./bugzoo/serve.mjs', import.meta.url));
const DAEMON_ENTRY = fileURLToPath(new URL('../src/daemon/daemon.mjs', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args, timeout = 60000, extra = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', timeout, env: { ...process.env, GLASSBOX_NO_OPEN: '1' }, ...extra,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function readD() { try { return JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8')); } catch { return null; } }
function readReport(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function startZooProcess() {
  const child = spawn(process.execPath, [SERVE], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => { /* keep the pipe drained */ });
  const dl = Date.now() + 15000;
  while (Date.now() < dl) {
    const m = /bugzoo on (http:\/\/\S+)/.exec(out);
    if (m) return { child, base: m[1].trim(), close: () => { try { child.kill(); } catch { /* gone */ } } };
    await delay(100);
  }
  throw new Error(`bug zoo did not start: ${out.slice(0, 200)}`);
}

let zoo = null;
async function run() {
  zoo = await startZooProcess();
  const base = zoo.base;

  cli(['kill-all']);
  await delay(500);
  check('0 precondition clean', !fs.existsSync(PATHS.daemonFile) && listGlassboxChromium().length === 0,
    `chromium ${listGlassboxChromium().length}`);

  cli(['--json', 'daemon', 'start']);
  const d = readD();
  if (!d) return check('daemon up', false, 'no daemon.json');

  const mk = (name, opts) => daemonReq(d, 'POST', '/sessions', { name, ...(opts || {}) }, 90000);
  const post = (s, verb, body, ms) => daemonReq(d, 'POST', `/sessions/${s}/${verb}`, body || {}, ms || 60000);
  const act = async (s, verb, body, ms) => (await post(s, verb, body, ms)).body;
  const goto = (s, url) => act(s, 'goto', { url }, 60000);
  const verify = (s, body) => act(s, 'verify', body || {}, 180000);
  const evalIn = async (s, expression) => (await act(s, 'eval', { expression }, 30000)).value;

  // ===== W5 — a closed <details> is disclosure, not invisibility ===============
  await mk('w5');
  await goto('w5', base + '/details.html');
  const v5 = await verify('w5', { axe: false, screenshots: false });
  const r5 = readReport(v5.artifacts?.report) || {};
  const collapsed = r5.layout?.collapsed || [];
  const byDesc = Object.fromEntries(collapsed.map((g) => [g.desc, g]));
  check('W5a a closed <details> collapses to ONE info line per widget, with zero pathology',
    (r5.layout?.invisible || []).length === 0 && v5.counts.layout === 0 && v5.ok === true
    && collapsed.length === 3 && byDesc['details.disclose']?.count === 10,
    `invisible=${(r5.layout?.invisible || []).length} layout=${v5.counts.layout} ok=${v5.ok} groups=${collapsed.map((g) => g.desc + '×' + g.count).join(' ')}`);

  const lines = (v5.findings || []).filter((f) => /open to audit/.test(f.summary));
  check('W5b the info line names the widget and its summary text, and every line is info-level',
    lines.length === 3 && lines.every((f) => f.severity === 'info')
    && lines.some((f) => /collapsed <details>/.test(f.summary) && /Show the rent chart & receipts/.test(f.summary))
    && lines.some((f) => /hidden="until-found"/.test(f.summary) && /div#untilfound/.test(f.summary)),
    lines.map((f) => f.summary.slice(0, 60)).join(' | ') || 'none');

  check('W5c nothing in the report blames content-visibility for the collapsed content',
    !/cannot be seen \(content-visibility\)/.test(JSON.stringify(r5.layout || {}))
    && !(v5.findings || []).some((f) => /Invisible interactive/.test(f.summary)),
    `invisible findings=${(v5.findings || []).filter((f) => /Invisible interactive/.test(f.summary)).length}`);

  // The honesty fallback: an OPEN <details> frozen shut by author CSS on the UA pseudo. Nothing in
  // the DOM chain explains it and closest() cannot match, so the audit must say exactly that.
  await goto('w5', base + '/pseudo-hide.html');
  const vp = await verify('w5', { axe: false, screenshots: false });
  const rp = readReport(vp.artifacts?.report) || {};
  const inv = rp.layout?.invisible || [];
  check('W5d an unexplained hide states the cause is OUTSIDE the DOM chain (never a wrong mechanism)',
    inv.length === 1 && /frozen-link/.test(inv[0].desc)
    && /outside the DOM ancestor chain/.test(inv[0].detail) && !/\(content-visibility\)/.test(inv[0].detail),
    inv[0] ? `${inv[0].desc}: ${inv[0].detail.slice(0, 70)}…` : 'no invisible finding');

  // Opening the widget makes its content auditable — the info line's advice is really actionable.
  await goto('w5', base + '/details.html');
  await act('w5', 'click', { selector: 'details.disclose > summary' }, 30000);
  const vOpen = await verify('w5', { axe: false, screenshots: false });
  check('W5e opening the <details> clears the line (the content really was just disclosed)',
    (vOpen.counts.collapsed || 0) < (v5.counts.collapsed || 0) && vOpen.ok === true,
    `collapsed ${v5.counts.collapsed} → ${vOpen.counts.collapsed || 0}`);

  // ===== W6 — a clipped capture must be framed and painted ====================
  await mk('w6');
  await goto('w6', base + '/details.html');
  const before = await act('w6', 'screenshot', { selector: 'header' }, 60000);
  // Clicking a control scrolls it into view — the innocent act that poisoned every later capture.
  await act('w6', 'click', { selector: '#d2-summary' }, 60000);
  const scrollY = await evalIn('w6', 'Math.round(window.scrollY)');
  const after = await act('w6', 'screenshot', { selector: 'header' }, 60000);
  check('W6a a selector capture survives the scroll a click causes (the filed repro)',
    scrollY > 500 && after.bytes > blankFloorBytes(after.w, after.h)
    && Math.abs(after.bytes - before.bytes) / before.bytes < 0.1 && !after.warning,
    `scrollY=${scrollY} before=${before.bytes}B after=${after.bytes}B floor=${blankFloorBytes(after.w, after.h)}B`);

  await act('w6', 'scroll', { to: '#lede' }, 30000);
  const lede = await act('w6', 'screenshot', { selector: '#lede' }, 60000);
  const ledeBox = await evalIn('w6', "JSON.stringify((()=>{const b=document.querySelector('#lede').getBoundingClientRect();return [Math.round(b.width),Math.round(b.height)]})())");
  check('W6b a scrolled element is captured where it really is, correctly framed and painted',
    lede.bytes > 10000 && !lede.warning && JSON.parse(ledeBox)[0] === lede.w && JSON.parse(ledeBox)[1] === lede.h,
    `${lede.bytes}B ${lede.w}x${lede.h} vs box ${ledeBox} floor=${blankFloorBytes(lede.w, lede.h)}B`);

  // The selector path force-paints too: an element inside an unpainted content-visibility:auto
  // section used to clip to blank paper exactly like the full-page case did (W2's cousin).
  await goto('w6', base + '/deferred.html');
  const unpainted = await act('w6', 'screenshot', { selector: '#pattern', forcePaint: false }, 60000);
  const painted = await act('w6', 'screenshot', { selector: '#pattern' }, 60000);
  check('W6c the selector path force-paints deferred content (not just the full-page path)',
    painted.forcedPaint >= 1 && painted.bytes > unpainted.bytes * 5,
    `forcePaint off=${unpainted.bytes}B on=${painted.bytes}B (${(painted.bytes / unpainted.bytes).toFixed(1)}x) forcedPaint=${painted.forcedPaint}`);

  // Guardrail: a visible element with content that clips to a featureless image is FLAGGED.
  await goto('w6', base + '/details.html');
  const blank = await act('w6', 'screenshot', { selector: '#blankbox' }, 60000);
  const solid = await act('w6', 'screenshot', { selector: 'header' }, 60000);
  const sparse = await act('w6', 'screenshot', { selector: '.filler' }, 60000);
  check('W6d a featureless clip of a visible element is warned about, never handed back silently',
    !!blank.warning && /may be blank/.test(blank.warning) && !solid.warning && !sparse.warning,
    `blank=${blank.bytes}B warn=${!!blank.warning} | header=${solid.bytes}B warn=${!!solid.warning} | sparse ${sparse.w}x${sparse.h}=${sparse.bytes}B warn=${!!sparse.warning}`);

  // …and the floor itself discriminates on the MEASURED numbers, not on a guess: an empty webp is
  // mostly fixed overhead (grows with √area) while content grows with area, so a per-pixel floor
  // would flag the big sparse block and miss the small blank one.
  check('W6e the blank floor separates every measured case (blank vs painted vs large-but-sparse)',
    462 < blankFloorBytes(1280, 168) && 6380 > blankFloorBytes(1280, 168)
    && 970 < blankFloorBytes(1248, 180) && 24626 > blankFloorBytes(1248, 180)
    && 6486 > blankFloorBytes(1280, 1432),
    `floors: 1280x168=${blankFloorBytes(1280, 168)} 1248x180=${blankFloorBytes(1248, 180)} 1280x1432=${blankFloorBytes(1280, 1432)}`);

  const cliShot = cli(['shot', '--selector', '#blankbox', '-s', 'w6'], 60000);
  check('W6f the CLI surfaces that warning (it is the human-facing path)',
    cliShot.status === 0 && /! clip may be blank/.test(cliShot.stdout),
    cliShot.stdout.trim().split('\n').pop());

  // ===== teardown =============================================================
  const beforeN = listGlassboxChromium().length;
  const ka = cli(['--json', 'kill-all']);
  await delay(1500);
  const after2 = listGlassboxChromium().length;
  const lingering = fs.existsSync(PATHS.daemonFile)
    ? `${fs.readFileSync(PATHS.daemonFile, 'utf8').slice(0, 80)} age=${Date.now() - fs.statSync(PATHS.daemonFile).mtimeMs}ms` : '';
  check('z1 kill-all removes daemon.json', !lingering, lingering || ka.stdout.trim().slice(0, 90));
  check('z2 kill-all leaves zero chromium orphans', after2 === 0, `chromium ${beforeN} -> ${after2}`);

  // A daemon whose discovery file is gone used to be unreapable — and it keeps a browser alive, so
  // the NEXT run's "precondition clean" check finds chromium nobody can account for. This bit the
  // round-3 session three times before it was traced, so it is pinned here.
  const stray = spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: 'ignore', windowsHide: true });
  stray.unref();
  const dl = Date.now() + 20000;
  while (Date.now() < dl && !fs.existsSync(PATHS.daemonFile)) await delay(200);
  const strayLive = fs.existsSync(PATHS.daemonFile) && processAlive(stray.pid);
  try { fs.unlinkSync(PATHS.daemonFile); } catch { /* already gone */ }   // orphan it
  cli(['--json', 'kill-all']);
  await delay(1200);
  check('z3 kill-all reaps a daemon whose discovery file is gone (found by command line, PID-verified)',
    strayLive && !processAlive(stray.pid),
    `stray pid=${stray.pid} started=${strayLive} aliveAfter=${processAlive(stray.pid)}`);
}

function finish() {
  try { zoo?.close(); } catch { /* already gone */ }
  cli(['kill-all']);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.log('FAIL  harness threw —', e?.stack || e);
  results.push({ name: 'harness', pass: false });
}).finally(finish);
