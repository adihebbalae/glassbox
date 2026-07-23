#!/usr/bin/env node
// `glassbox` — the CLI. Verbs map to daemon HTTP routes. Any verb needing the daemon reads
// the discovery file and auto-starts a detached daemon on demand (poll until ping+probe live,
// 15s cap). Human-readable output by default; --json for machine consumers. Stays
// playwright-free (only the daemon imports it) so cold CLI startup is fast.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PATHS, daemonReq, pingDaemon, probeDaemon,
} from './protocol.mjs';
import {
  verifyGlassboxPid, processAlive, taskkillTree, listGlassboxChromium, sweepOrphans,
} from './daemon/prockit.mjs';

const DAEMON_ENTRY = fileURLToPath(new URL('./daemon/daemon.mjs', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let JSON_MODE = false;

// Thrown by fail() to unwind to main(). We set process.exitCode and let the loop drain rather
// than calling process.exit() mid-fetch (see the connection:close note in protocol.mjs).
class ExitSignal extends Error {}

function readDaemonFile() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8'));
  } catch {
    return null;
  }
}

function out(obj, human) {
  if (JSON_MODE) console.log(JSON.stringify(obj));
  else console.log(human);
}
function fail(error) {
  const e = error || { code: 'INTERNAL', message: 'unknown error' };
  if (JSON_MODE) console.log(JSON.stringify({ error: e }));
  else {
    console.error(`error [${e.code}]: ${e.message}`);
    if (e.valid_values) console.error(`  valid: ${e.valid_values.join(', ') || '(none)'}`);
    if (e.correction_hint) console.error(`  hint: ${e.correction_hint}`);
  }
  process.exitCode = 1;
  throw new ExitSignal();
}

async function ensureDaemon() {
  const existing = readDaemonFile();
  if (existing && (await pingDaemon(existing))) return existing; // fast path
  spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await delay(200);
    const d = readDaemonFile();
    if (d && (await pingDaemon(d)) && (await probeDaemon(d))) return d;
  }
  fail({ code: 'DAEMON_UNREACHABLE', message: 'daemon did not become live within 15s' });
}

// ---- verbs ----------------------------------------------------------------

async function daemonStart() {
  const d = await ensureDaemon();
  out({ running: true, pid: d.pid, port: d.port }, `daemon running (pid ${d.pid}, port ${d.port})`);
}

async function daemonStop() {
  const d = readDaemonFile();
  if (!d || !(await pingDaemon(d))) return out({ running: false }, 'daemon not running');
  try {
    await daemonReq(d, 'POST', '/shutdown', {}, 5000);
  } catch {
    /* it may drop the socket as it exits */
  }
  out({ stopped: true, pid: d.pid }, `daemon stopped (pid ${d.pid})`);
}

async function daemonStatus() {
  const d = readDaemonFile();
  if (!d) return out({ running: false }, 'daemon not running');
  const r = await daemonReq(d, 'GET', '/ping', undefined, 4000).catch(() => ({ status: 0, body: {} }));
  if (r.status !== 200 || !r.body.pong) return out({ running: false, stale: true }, 'daemon not running (stale discovery file)');
  const b = r.body;
  out(
    { running: true, pid: b.pid, port: d.port, sessions: b.sessions, browserLaunched: b.browserLaunched, uptimeMs: Date.now() - b.startTime },
    `daemon running (pid ${b.pid}, port ${d.port}) — ${b.sessions} session(s), browser ${b.browserLaunched ? 'up' : 'lazy'}`
  );
}

async function sessionOpen(name, opts) {
  if (!name) fail({ code: 'BAD_REQUEST', message: 'session name required', correction_hint: 'glassbox session open <name>' });
  const d = await ensureDaemon();
  const { status, body } = await daemonReq(d, 'POST', '/sessions', { name, ...opts });
  if (status !== 200) return fail(body.error);
  out(body, `session '${name}' open (${body.headed ? 'headed' : 'headless'})`);
}

async function sessionLs() {
  const d = await ensureDaemon();
  const { body } = await daemonReq(d, 'GET', '/sessions');
  const rows = body.sessions || [];
  if (JSON_MODE) return out({ sessions: rows });
  if (!rows.length) return console.log('no sessions');
  for (const s of rows) {
    console.log(`${s.name}\t${s.headed ? 'headed' : 'headless'}\t${s.url || '-'}\tidle ${Math.round(s.idleMs / 1000)}s`);
  }
}

async function sessionRm(name) {
  if (!name) fail({ code: 'BAD_REQUEST', message: 'session name required', correction_hint: 'glassbox session rm <name>' });
  const d = await ensureDaemon();
  const { status, body } = await daemonReq(d, 'DELETE', `/sessions/${encodeURIComponent(name)}`);
  if (status !== 200) return fail(body.error);
  out(body, `session '${name}' removed`);
}

async function killAll() {
  const d = readDaemonFile();
  const daemonPid = d?.pid;
  if (d) {
    try {
      await daemonReq(d, 'POST', '/shutdown', {}, 5000);
    } catch {
      /* best effort */
    }
    const dl = Date.now() + 5000;
    while (Date.now() < dl && (await pingDaemon(d))) await delay(150);
  }
  // Force-kill the daemon only after confirming the PID is really ours (PID-reuse guard).
  if (daemonPid && processAlive(daemonPid) && verifyGlassboxPid(daemonPid)) taskkillTree(daemonPid);
  const before = listGlassboxChromium().length;
  sweepOrphans();
  await delay(300);
  const after = listGlassboxChromium().length;
  try {
    fs.unlinkSync(PATHS.daemonFile);
  } catch {
    /* already gone */
  }
  out(
    { ok: true, daemonPid: daemonPid ?? null, chromiumBefore: before, chromiumAfter: after },
    `kill-all done — daemon ${daemonPid ?? '(none)'}, chromium ${before} -> ${after}`
  );
}

// ---- arg parsing ----------------------------------------------------------

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') JSON_MODE = true;
    else if (a === '--headed') opts.headed = true;
    else if (a === '--viewport') {
      const m = /^(\d+)x(\d+)$/.exec(argv[++i] || '');
      if (!m) fail({ code: 'BAD_REQUEST', message: 'bad --viewport, expected WxH e.g. 1280x800' });
      opts.viewport = { width: Number(m[1]), height: Number(m[2]) };
    } else if (a === '--color') opts.colorScheme = argv[++i];
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else pos.push(a);
  }
  return { pos, opts };
}

const HELP = `glassbox <command>

  daemon start|stop|status
  session open <name> [--headed] [--viewport WxH] [--color light|dark] [--base-url URL]
  session ls
  session rm <name>
  kill-all
  [--json] on any command for machine-readable output`;

async function main() {
  try {
    const { pos, opts } = parseArgs(process.argv.slice(2));
    const [verb, sub, arg] = pos;
    if (verb === 'daemon' && sub === 'start') return await daemonStart();
    if (verb === 'daemon' && sub === 'stop') return await daemonStop();
    if (verb === 'daemon' && sub === 'status') return await daemonStatus();
    if (verb === 'session' && sub === 'open') return await sessionOpen(arg, opts);
    if (verb === 'session' && (sub === 'ls' || sub === 'list')) return await sessionLs();
    if (verb === 'session' && (sub === 'rm' || sub === 'close')) return await sessionRm(arg);
    if (verb === 'kill-all') return await killAll();
    console.log(HELP);
    process.exitCode = verb ? 1 : 0;
  } catch (e) {
    if (e instanceof ExitSignal) return; // exitCode already set, message already printed
    console.error(`error [INTERNAL]: ${e?.message || e}`);
    if (JSON_MODE) console.log(JSON.stringify({ error: { code: 'INTERNAL', message: e?.message || String(e) } }));
    process.exitCode = 1;
  }
}

main();
