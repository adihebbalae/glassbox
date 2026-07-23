// M4 proof: the white-box debug plane. Cold-starts the daemon via the CLI, serves the bug-zoo,
// and drives debug/style/coverage over HTTP like m3. Asserts the whole arch §6 contract:
//   - a breakpoint resolves past the declaration line (spike-2 off-by-one) and pauses on a click,
//   - while paused: a local var reads WITH its value, eval-on-frame computes with locals, a
//     screenshot of the frozen page succeeds, and a SIBLING session stays fully live,
//   - a normal action on the paused session returns a structured PAUSED error (never a hang),
//   - step-over advances the line, resume completes and the handler side-effect is visible,
//   - listeners on a dead button is empty; on a live button is one click listener with a source loc,
//   - coverage flags the never-clicked handler (count 0) while the clicked one ran, + unused CSS,
//   - style explains a white-on-white element: winning rule/selector, contrast < 1.5, ✗ overridden.
// kill-all + zero-orphan check at the end. Run: `node test/m4.mjs`.
//
// The triggering click is FIRE-AND-FORGET: a paused handler blocks the CDP input dispatch (spike 2),
// so awaiting it would deadlock the proof. We poll debug `state` until paused instead, then resume.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS, daemonReq } from '../src/protocol.mjs';
import { listGlassboxChromium } from '../src/daemon/prockit.mjs';
import { startBugzoo } from './bugzoo/serve.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args, timeout = 60000) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function readD() { try { return JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8')); } catch { return null; } }
function readReport(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

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

  const r2 = cli(['--json', 'session', 'open', 'dbg']);
  const d = readD();
  check('2 cold CLI open auto-starts daemon', r2.status === 0 && !!d, `exit=${r2.status}`);
  if (!d) return;
  const post = (s, verb, body, ms) => daemonReq(d, 'POST', `/sessions/${s}/${verb}`, body || {}, ms);
  const act = async (s, verb, body, ms) => (await post(s, verb, body, ms)).body;
  const dbg = (s, body) => act(s, 'debug', body, 60000);
  const goto = (s, url) => act(s, 'goto', { url }, 30000);
  const createSession = (name) => daemonReq(d, 'POST', '/sessions', { name });

  // --- a. breakpoint resolves + pauses on a click ---------------------------
  await goto('dbg', base + '/debug.html');
  const br = await dbg('dbg', { op: 'break', file: 'debug.js', line: 5 });
  check('a1 break resolves via getPossibleBreakpoints', br.ok && /debug\.js$/.test(br.file) && br.line >= 5,
    `file=${br.file} line=${br.line} requested=${br.requested}`);

  const clickP = post('dbg', 'click', { selector: '#primary' }, 60000).catch(() => {}); // fire-and-forget
  let st = { paused: false };
  for (let i = 0; i < 80 && !st.paused; i++) { st = await dbg('dbg', { op: 'state' }); if (!st.paused) await delay(100); }
  check('a2 click paused at the breakpoint handler', st.paused && st.frames?.[0]?.functionName === 'onPrimary',
    `paused=${st.paused} fn=${st.frames?.[0]?.functionName} line=${st.frames?.[0]?.line}`);
  const pausedLine = st.frames?.[0]?.line;

  // --- b. inspect a local var WITH its value (past the declaration line) -----
  const ins = await dbg('dbg', { op: 'inspect' });
  let totalVar = null;
  for (const sc of ins.scopes || []) { const v = (sc.vars || []).find((x) => x.name === 'total'); if (v) { totalVar = v; break; } }
  check('b inspect: local var reads WITH its value (not undefined)', totalVar && Number(totalVar.value) === 21,
    `total=${totalVar?.value} scopes=${(ins.scopes || []).map((s) => s.type).join(',')}`);

  // --- c. eval-on-frame with locals; screenshot while paused; sibling live ---
  const ev = await dbg('dbg', { op: 'eval', expression: 'total + doubled' });
  check('c1 eval-on-frame computes with locals', ev.value === 63, `value=${ev.value} type=${ev.type}`);

  const shot = await dbg('dbg', { op: 'screenshot' });
  check('c2 screenshot succeeds while paused', shot.ok && shot.bytes > 0 && fs.existsSync(shot.path),
    `bytes=${shot.bytes} path=${shot.path}`);

  await createSession('sib');
  await goto('sib', base + '/clean.html');
  const sibObs = await act('sib', 'observe', {});
  check('c3 sibling session stays live while dbg is paused', sibObs.ok === true && /button/.test(sibObs.text || ''),
    `sibNodes=${sibObs.count}`);

  // --- d. normal action on the paused session → structured PAUSED (no hang) --
  const t0 = Date.now();
  const pausedTry = await post('dbg', 'click', { selector: '#dead' }, 10000);
  check('d normal action on paused session → PAUSED error (fast, no hang)',
    pausedTry.status === 409 && pausedTry.body.error?.code === 'PAUSED' && Date.now() - t0 < 5000,
    `status=${pausedTry.status} code=${pausedTry.body.error?.code} ms=${Date.now() - t0}`);

  // --- e. step over advances the line; resume completes; side-effect visible -
  const step = await dbg('dbg', { op: 'step', mode: 'over' });
  check('e1 step over advances the line', step.paused && step.frames?.[0]?.line > pausedLine,
    `from=${pausedLine} to=${step.frames?.[0]?.line}`);

  const res = await dbg('dbg', { op: 'resume' });
  await Promise.race([clickP, delay(8000)]); // the parked click now completes
  const afterObs = await act('dbg', 'observe', {});
  check('e2 resume completes; handler side-effect visible', res.resumed === true && /primary-done-42/.test(afterObs.text || ''),
    `resumed=${res.resumed} result=${/primary-done-42/.test(afterObs.text || '')}`);

  // --- f. listeners: dead button empty, live button one click listener -------
  const deadL = await dbg('dbg', { op: 'listeners', selector: '#dead' });
  check('f1 listeners on the dead button → empty', deadL.ok && deadL.count === 0, `count=${deadL.count}`);
  const liveL = await dbg('dbg', { op: 'listeners', selector: '#primary' });
  check('f2 listeners on the live button → 1 click listener with source loc',
    liveL.count === 1 && liveL.listeners?.[0]?.type === 'click' && /debug\.js/.test(liveL.listeners?.[0]?.sourceLoc || ''),
    `count=${liveL.count} type=${liveL.listeners?.[0]?.type} loc=${liveL.listeners?.[0]?.sourceLoc}`);

  // --- g. coverage: never-clicked handler flagged; clicked one ran; css unused.
  // Start coverage BEFORE navigation (research 02 §8) so load-time JS/CSS is tracked.
  await createSession('cov');
  const covS = await dbg('cov', { op: 'coverage-start' });
  await goto('cov', base + '/debug.html');
  await act('cov', 'click', { selector: '#primary' }); // real click, onPrimary runs to completion
  const covE = await dbg('cov', { op: 'coverage-stop' });
  const covFull = readReport(covE.report) || { js: { functions: [] } };
  const onPrimaryFn = (covFull.js.functions || []).find((f) => f.functionName === 'onPrimary');
  const secNever = (covE.js.neverRan || []).some((f) => f.functionName === 'onSecondary');
  check('g1 coverage: never-clicked handler in never-ran list', covS.ok && secNever,
    `neverRan=${(covE.js.neverRan || []).map((f) => f.functionName).join(',')}`);
  check('g2 coverage: clicked handler has count ≥ 1', onPrimaryFn && onPrimaryFn.count >= 1, `onPrimary.count=${onPrimaryFn?.count}`);
  check('g3 coverage: CSS unused count > 0', covE.css?.unusedRules > 0,
    `unused=${covE.css?.unusedRules}/${covE.css?.totalRules} top=${(covE.css?.topUnused || []).slice(0, 3).join(' ')}`);

  // --- h. style explains the white-on-white element --------------------------
  const sty = await act('dbg', 'style', { selector: '#whiteout' });
  const colorRuleWon = (sty.cascade || []).find((r) => r.selector === '#whiteout' && r.properties.some((p) => p.name === 'color' && p.status === 'won'));
  const colorOverridden = (sty.cascade || []).some((r) => r.properties.some((p) => p.name === 'color' && p.status === 'overridden' && p.winner === '#whiteout'));
  check('h1 style: cascade names the winning rule + selector', sty.ok && !!colorRuleWon,
    `top=${sty.cascade?.[0]?.selector} rules=${sty.rules}`);
  check('h2 style: effective contrast ratio < 1.5 reported', sty.contrast && sty.contrast.ratio < 1.5 && sty.contrast.wcagAA === false,
    `ratio=${sty.contrast?.ratio} fg=${sty.contrast?.fg} bg=${sty.contrast?.bg}`);
  check('h3 style: the overridden rule is marked ✗', colorOverridden,
    `overridden=${colorOverridden}`);

  // --- CLI surface: debug state + style print without error ------------------
  const cliDbg = cli(['debug', 'list', '-s', 'dbg']);
  check('i1 CLI debug verb', cliDbg.status === 0, `exit=${cliDbg.status} out=${cliDbg.stdout.trim().slice(0, 40)}`);
  const cliSty = cli(['style', '#whiteout', '-s', 'dbg']);
  check('i2 CLI style verb', cliSty.status === 0 && /cascade/.test(cliSty.stdout), `exit=${cliSty.status}`);

  // --- teardown: zero orphan chromium ---------------------------------------
  const before = listGlassboxChromium().length;
  cli(['--json', 'kill-all']);
  await delay(700);
  const after = listGlassboxChromium().length;
  check('j1 kill-all removes daemon.json', !fs.existsSync(PATHS.daemonFile));
  check('j2 kill-all leaves zero chromium strays', after === 0, `chromium ${before} -> ${after}`);
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
