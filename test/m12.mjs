// M12 proof: defect round 4 (DegreeForge TASK-119, docs/defects-2026-07-26-degreeforge-task119.md).
// One machine-wide daemon serves every agent, and its destroy verbs used to carry no concept of
// whose sessions they were tearing down — a colleague's `kill-all` silently ended a live
// verification mid-checklist. Every check here FAILS at c9f94d7/7c4ad7d (verified by stashing src/).
//
//   a  a bare kill-all from one client REFUSES while another client's sessions are live, naming
//      them — and that client's sessions are still there and still usable afterwards
//   b  `kill-all --mine` destroys only the caller's, leaving the daemon up for everyone else
//   c  `kill-all --force` keeps the full machine-wide clean slate (wedge recovery)
//   d  NO_SESSION carries the daemon's identity, so "the daemon churned under me" is one call
//   e  the MCP shim owns its sessions automatically (mcp-<pid>) — MCP agents get this for free
//   f  a single anonymous client is unaffected: anonymous owns anonymous, bare kill-all still works
//   g  STALE foreign sessions never block a clean slate (the recency window is the whole guard)
//
// The bug zoo runs as a CHILD PROCESS (the M5/M7 deadlock lesson). Run: `node test/m12.mjs`.
process.env.GLASSBOX_SETTLE_CAP_MS = '2500';

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS, CODES, HTTP_STATUS, daemonReq, readDaemonFile } from '../src/protocol.mjs';
import { listGlassboxChromium } from '../src/daemon/prockit.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const SERVE = fileURLToPath(new URL('./bugzoo/serve.mjs', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run the CLI as a named client (the id an agent would export once). */
function cli(args, client, timeout = 90000) {
  const env = { ...process.env, GLASSBOX_NO_OPEN: '1' };
  if (client) env.GLASSBOX_CLIENT = client; else delete env.GLASSBOX_CLIENT;
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout, env });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const json = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; } };

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

const A = 'gbx-a';   // "another agent, mid-verification"
const B = 'gbx-b';   // "me, cleaning up after my task"

let zoo = null;
async function run() {
  zoo = await startZooProcess();
  const base = zoo.base;

  cli(['kill-all', '--force'], null);
  await delay(500);
  check('0 precondition clean', !fs.existsSync(PATHS.daemonFile) && listGlassboxChromium().length === 0,
    `chromium ${listGlassboxChromium().length}`);

  // ===== a — a bare kill-all must not take down someone else's live work ======
  cli(['session', 'open', 'a1'], A);
  cli(['session', 'open', 'a2'], A);
  cli(['session', 'open', 'b1'], B);
  const d = readDaemonFile();
  if (!d) return check('daemon up', false, 'no daemon.json');
  cli(['goto', base + '/clean.html', '-s', 'a1'], A); // a is genuinely mid-task

  const ls = json(cli(['--json', 'session', 'ls'], B));
  const owners = Object.fromEntries((ls?.sessions || []).map((s) => [s.name, s.client]));
  check('a1 sessions record WHO opened them (session ls shows the owner)',
    owners.a1 === A && owners.a2 === A && owners.b1 === B && ls.you === B,
    `owners=${JSON.stringify(owners)} you=${ls?.you}`);

  const refused = cli(['--json', 'kill-all'], B);
  const err = json(refused)?.error;
  check('a2 a bare kill-all REFUSES while another client is live, and names them',
    refused.status !== 0 && err?.code === CODES.FOREIGN_SESSIONS
    && err.foreign?.[0]?.client === A && err.foreign[0].count === 2
    && /--mine/.test(err.correction_hint || '') && /--force/.test(err.correction_hint || ''),
    `exit=${refused.status} code=${err?.code} foreign=${JSON.stringify(err?.foreign?.map((g) => g.client + '×' + g.count))}`);

  const stillThere = json(cli(['--json', 'session', 'ls'], A));
  const evalOk = json(cli(['--json', 'eval', '1+1', '-s', 'a1'], A));
  check('a3 …and the other client\'s sessions are still alive AND still usable',
    (stillThere?.sessions || []).filter((s) => s.client === A).length === 2 && evalOk?.value === 2,
    `aSessions=${(stillThere?.sessions || []).filter((s) => s.client === A).length} eval=${evalOk?.value}`);

  // ===== b — --mine is the scoped cleanup verb ================================
  const mine = json(cli(['--json', 'kill-all', '--mine'], B));
  const after = json(cli(['--json', 'session', 'ls'], A));
  const status = cli(['daemon', 'status'], A);
  check('b1 `kill-all --mine` destroys only the caller\'s sessions',
    mine?.mode === 'mine' && mine.destroyed.length === 1 && mine.destroyed[0] === 'b1'
    && mine.remaining === 2 && mine.daemonStopped === false,
    `destroyed=${JSON.stringify(mine?.destroyed)} remaining=${mine?.remaining}`);
  check('b2 …the other client keeps both sessions and the daemon stays up',
    (after?.sessions || []).length === 2 && (after?.sessions || []).every((s) => s.client === A)
    && /daemon running/.test(status.stdout) && /2 session/.test(status.stdout),
    `left=${(after?.sessions || []).map((s) => s.name).join(',')} | ${status.stdout.trim()}`);

  // ===== d — which daemon answered? (the round-4 observation) =================
  const gone = cli(['--json', 'eval', '1+1', '-s', 'no-such-session'], A);
  const goneErr = json(gone)?.error;
  const human = cli(['eval', '1+1', '-s', 'no-such-session'], A);
  check('d1 NO_SESSION carries the daemon identity (pid + startedAt), and the CLI prints it',
    goneErr?.code === CODES.NO_SESSION && goneErr.daemon?.pid === d.pid && goneErr.daemon.startedAt > 0
    && /daemon: pid \d+, up since \d\d:\d\d:\d\d/.test(human.stderr) && /restarted/.test(human.stderr),
    `pid=${goneErr?.daemon?.pid} (daemon.json pid=${d.pid})`);

  // ===== c — --force keeps the machine-wide clean slate =======================
  const forced = json(cli(['--json', 'kill-all', '--force'], B));
  await delay(500);
  check('c1 `kill-all --force` still takes everything down (wedge recovery, blast radius intended)',
    forced?.ok === true && forced.mode === 'force' && !fs.existsSync(PATHS.daemonFile)
    && listGlassboxChromium().length === 0,
    `mode=${forced?.mode} daemon.json=${fs.existsSync(PATHS.daemonFile)} chromium=${listGlassboxChromium().length}`);

  // ===== e — the MCP shim identifies itself automatically =====================
  const shim = spawn(process.execPath, [CLI, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GLASSBOX_NO_OPEN: '1', GLASSBOX_CLIENT: '' } });
  shim.stdout.setEncoding('utf8');
  shim.stderr.setEncoding('utf8');
  let shimOut = '';
  shim.stdout.on('data', (c) => { shimOut += c; });
  shim.stderr.on('data', () => { /* diagnostics off the protocol stream */ });
  const rpc = (o) => shim.stdin.write(JSON.stringify(o) + '\n');
  rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm12', version: '0' } } });
  rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gb_session', arguments: { op: 'open', name: 'm12mcp' } } });
  const dl = Date.now() + 90000;
  while (Date.now() < dl && !/m12mcp/.test(shimOut)) await delay(200);
  const mcpLs = json(cli(['--json', 'session', 'ls'], B));
  const mcpSession = (mcpLs?.sessions || []).find((s) => s.name === 'm12mcp');
  check('e1 an MCP shim owns its sessions automatically (client mcp-<pid>, no config required)',
    mcpSession?.client === `mcp-${shim.pid}` && shimOut.includes(`mcp-${shim.pid}`), // …and the tool result says so
    `owner=${mcpSession?.client} expected=mcp-${shim.pid} inToolResult=${shimOut.includes(`mcp-${shim.pid}`)}`);
  // …and another client cannot reap them by accident.
  const vsMcp = json(cli(['--json', 'kill-all'], B))?.error;
  check('e2 …so a sibling agent\'s bare kill-all cannot reap the MCP agent\'s sessions',
    vsMcp?.code === CODES.FOREIGN_SESSIONS && vsMcp.foreign?.[0]?.client === `mcp-${shim.pid}`,
    `code=${vsMcp?.code} foreign=${vsMcp?.foreign?.[0]?.client}`);
  shim.stdin.end();
  await delay(300);
  cli(['kill-all', '--force'], null);
  await delay(500);

  // ===== f — the single-agent path is untouched ===============================
  cli(['session', 'open', 'solo'], null);            // no GLASSBOX_CLIENT at all
  const solo = json(cli(['--json', 'kill-all'], null));
  check('f1 an anonymous client still owns anonymous sessions — bare kill-all works as before',
    solo?.ok === true && solo.mode === 'all' && !fs.existsSync(PATHS.daemonFile),
    `mode=${solo?.mode} daemon.json=${fs.existsSync(PATHS.daemonFile)}`);

  // ===== g — stale foreign sessions must never block a clean slate ============
  process.env.GLASSBOX_ACTIVE_WINDOW_MS = '800'; // the daemon we are about to spawn inherits it
  cli(['session', 'open', 'stale1'], A);
  await delay(1400);                              // now older than the window
  const staleKill = json(cli(['--json', 'kill-all'], B));
  check('g1 a foreign session idle past the recency window does not block the clean slate',
    staleKill?.ok === true && staleKill.mode === 'all' && !fs.existsSync(PATHS.daemonFile),
    `mode=${staleKill?.mode} err=${json(cli(['--json', 'daemon', 'status'], B))?.running}`);
  delete process.env.GLASSBOX_ACTIVE_WINDOW_MS;

  // ===== teardown =============================================================
  const beforeN = listGlassboxChromium().length;
  cli(['--json', 'kill-all', '--force'], null);
  await delay(1000);
  const after2 = listGlassboxChromium().length;
  check('z1 kill-all --force removes daemon.json', !fs.existsSync(PATHS.daemonFile));
  check('z2 kill-all --force leaves zero chromium orphans', after2 === 0, `chromium ${beforeN} -> ${after2}`);
}

function finish() {
  try { zoo?.close(); } catch { /* already gone */ }
  cli(['kill-all', '--force'], null); // --force: this file deliberately leaves foreign-owned sessions
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.log('FAIL  harness threw —', e?.stack || e);
  results.push({ name: 'harness', pass: false });
}).finally(finish);
