// M1 proof: daemon spine — auto-start, named parallel sessions, per-session serial queue,
// structured errors, PID-safe kill-all with zero chromium strays. Run: `node test/m1.mjs`.
// Imports only protocol + prockit (no playwright) so the test process stays light; the daemon
// and browser live in the detached process the CLI spawns.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS, daemonReq, pingDaemon } from '../src/protocol.mjs';
import { listGlassboxChromium } from '../src/daemon/prockit.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function cli(args, timeout = 30000) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function readD() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8'));
  } catch {
    return null;
  }
}
function parseJson(s) {
  try {
    return JSON.parse((s || '').trim().split(/\r?\n/).pop());
  } catch {
    return null;
  }
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function run() {
  // 1 — precondition: no daemon running (kill-all first, ignore errors)
  cli(['kill-all']);
  await delay(600);
  check('1 precondition clean', !fs.existsSync(PATHS.daemonFile) && listGlassboxChromium().length === 0,
    `daemon.json ${fs.existsSync(PATHS.daemonFile) ? 'present' : 'gone'}, chromium ${listGlassboxChromium().length}`);

  // 2 — cold `session open a` auto-starts the daemon
  const r2 = cli(['--json', 'session', 'open', 'a']);
  const d = readD();
  check('2 cold open auto-starts daemon', r2.status === 0 && !!d && (await pingDaemon(d)),
    `exit=${r2.status}, daemon ${d ? 'pid ' + d.pid : 'missing'}`);
  if (!d) return finish();

  // 3 — create 3 more sessions CONCURRENTLY — all succeed, list shows 4
  const created = await Promise.all(['b', 'c', 'd'].map((n) => daemonReq(d, 'POST', '/sessions', { name: n })));
  const ls = (await daemonReq(d, 'GET', '/sessions')).body.sessions || [];
  const names = ls.map((s) => s.name).sort();
  check('3 four concurrent sessions', created.every((x) => x.status === 200) && ls.length === 4 && eq(names, ['a', 'b', 'c', 'd']),
    `create=${created.map((x) => x.status).join(',')}, list=${names.join(',')}`);

  // core guarantee — per-session SERIAL queue: 5 concurrent probes on 'a' must serialize
  const probes = await Promise.all(Array.from({ length: 5 }, () => daemonReq(d, 'POST', '/sessions/a/probe')));
  const seqs = probes.map((x) => x.body.seq);
  check('3b per-session serial command queue', probes.every((x) => x.status === 200) && eq([...seqs].sort((a, b) => a - b), [0, 1, 2, 3, 4]),
    `observed seqs=${JSON.stringify(seqs)} (serialized => permutation of 0..4)`);

  // cross-session PARALLEL: independent sessions each start their queue at seq 0
  const par = await Promise.all([daemonReq(d, 'POST', '/sessions/c/probe'), daemonReq(d, 'POST', '/sessions/d/probe')]);
  check('3c cross-session parallelism', par.every((x) => x.status === 200 && x.body.seq === 0),
    `c/d probe seqs=${par.map((x) => x.body.seq).join(',')}`);

  // 4 — structural isolation: destroy one, other 3 stay intact and functional
  const del = await daemonReq(d, 'DELETE', '/sessions/b');
  const ls2 = (await daemonReq(d, 'GET', '/sessions')).body.sessions || [];
  const survivor = await daemonReq(d, 'POST', '/sessions/a/probe');
  check('4 destroy one, others intact + functional', del.status === 200 && ls2.length === 3 && survivor.status === 200,
    `deleted=b, remaining=${ls2.map((s) => s.name).sort().join(',')}, survivor-probe=${survivor.status}`);

  // 5 — duplicate name -> structured DUP_SESSION through the CLI, non-zero exit
  const r5 = cli(['--json', 'session', 'open', 'a']);
  const e5 = parseJson(r5.stdout)?.error;
  check('5 duplicate name -> DUP_SESSION', r5.status !== 0 && e5?.code === 'DUP_SESSION',
    `exit=${r5.status}, code=${e5?.code}`);

  // 6 — unknown session rm -> NO_SESSION listing valid_values
  const r6 = cli(['--json', 'session', 'rm', 'zzz']);
  const e6 = parseJson(r6.stdout)?.error;
  const validListed = Array.isArray(e6?.valid_values) && e6.valid_values.includes('a') && e6.valid_values.includes('c');
  check('6 unknown rm -> NO_SESSION + valid_values', r6.status !== 0 && e6?.code === 'NO_SESSION' && validListed,
    `code=${e6?.code}, valid_values=${JSON.stringify(e6?.valid_values)}`);

  // 7 — kill-all: daemon.json gone, zero chromium strays with our marker
  const before = listGlassboxChromium().length;
  const r7 = cli(['--json', 'kill-all']);
  const k = parseJson(r7.stdout);
  await delay(600);
  const after = listGlassboxChromium().length;
  check('7a kill-all removes daemon.json', !fs.existsSync(PATHS.daemonFile));
  check('7b kill-all leaves zero chromium strays', after === 0,
    `marker chromium before=${before} after=${after} (daemon reported ${k?.chromiumBefore}->${k?.chromiumAfter})`);
}

function finish() {
  cli(['kill-all']); // safety net so a mid-run failure never leaks a browser
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

run()
  .catch((e) => {
    console.log('FAIL  harness threw —', e?.stack || e);
    results.push({ name: 'harness', pass: false });
  })
  .finally(finish);
