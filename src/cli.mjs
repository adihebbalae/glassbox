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

// ---- M2 act/observe verbs -------------------------------------------------

// Resolve a target from flags (ref > testid > role[+name] > selector > text). For click/hover/
// dblclick a bare positional is treated as a CSS selector (selector-first grounding).
function buildTarget(verb, pos, opts) {
  if (opts.ref) return { ref: opts.ref };
  if (opts.testid) return { testid: opts.testid };
  if (opts.role) return { role: opts.role, ...(opts.name ? { name: opts.name } : {}) };
  if (opts.selector) return { selector: opts.selector };
  if (opts.text && !['type', 'press'].includes(verb)) return { text: opts.text };
  if (['click', 'dblclick', 'hover'].includes(verb) && pos[1]) return { selector: pos[1] };
  return {};
}

function buildBody(verb, pos, opts) {
  const t = buildTarget(verb, pos, opts);
  const timeout = opts.timeoutMs ? { timeoutMs: Number(opts.timeoutMs) } : {};
  switch (verb) {
    case 'goto': return { url: pos[1] || opts.url, ...timeout };
    case 'observe': return { ...(opts.selector ? { selector: opts.selector } : {}), ...(opts.limit ? { limit: Number(opts.limit) } : {}), ...(opts.cursor ? { cursor: Number(opts.cursor) } : {}) };
    case 'type': return { ...t, text: pos[1] ?? opts.text ?? '', submit: !!opts.submit, ...timeout };
    case 'press': return { key: pos[1] || opts.key, ...(t.selector || t.ref || t.testid || t.role ? t : {}), ...timeout };
    case 'scroll': {
      const to = opts.to;
      if (to && /^e\d+$/.test(to)) return { ref: to, ...timeout };
      return { ...(to ? { to } : {}), ...(opts.by ? { by: Number(opts.by) } : {}), ...timeout };
    }
    case 'dialog': return { action: pos[1] || opts.action || 'dismiss', ...(opts.text ? { text: opts.text } : {}) };
    case 'verify': return {
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.themes ? { themes: true } : {}),
      ...(opts.viewports ? { viewports: true } : {}),
      ...(opts.noAxe ? { axe: false } : {}),
      ...(opts.noShots ? { screenshots: false } : {}),
    };
    case 'read': return {
      channel: pos[1] || opts.channel || 'errors',
      ...(opts.since ? { since: Number(opts.since) } : {}),
      ...(opts.limit ? { limit: Number(opts.limit) } : {}),
    };
    case 'drag': return { from: { selector: opts.from }, to: { selector: opts.to }, ...timeout };
    case 'upload': return { ...t, files: (opts.files || '').split(',').filter(Boolean), ...timeout };
    case 'select': return { ...t, values: (opts.values || '').split(',').filter(Boolean), ...timeout };
    default: return { ...t, ...timeout }; // click, dblclick, hover
  }
}

function printResult(verb, r) {
  if (JSON_MODE) return out(r);
  if (verb === 'observe') {
    console.log(r.text || '(empty)');
    if (r.nextCursor != null) console.log(`\n… ${r.count} nodes total — next page: --cursor ${r.nextCursor}`);
    console.log(`\n[v${r.version} · ${r.count} nodes · ax ${r.axPath}]`);
    return;
  }
  if (verb === 'dialog') {
    console.log(`dialog ${r.action} — ${r.dialog.type} ${JSON.stringify(r.dialog.message)}; ${r.settled ? 'settled' : 'UNSETTLED'} at ${r.url}`);
    return;
  }
  if (verb === 'verify') {
    const c = r.counts || {};
    console.log(`verify ${r.ok ? 'OK' : 'ISSUES'} — ${r.settled ? 'settled' : 'UNSETTLED'} at ${r.url}`);
    console.log(`  counts: console=${c.consoleErrors} pageerr=${c.pageErrors} net(failed=${c.netFailed} http=${c.netHttpError} hang=${c.netHanging} mixed=${c.netMixed}) a11y=${c.a11y} layout=${c.layout}`);
    for (const f of r.findings || []) console.log(`  [${f.severity}/${f.channel}] ${f.summary}`);
    const a = r.artifacts || {};
    console.log(`  report: ${a.report}`);
    if (a.screenshots?.length) console.log(`  shots: ${a.screenshots.join(', ')}`);
    console.log(`  ${r.tookMs}ms`);
    return;
  }
  if (verb === 'read') {
    if (r.channel === 'overlay') { console.log(r.overlay ? `overlay [${r.overlay.framework}] ${r.overlay.message}` : 'no error overlay'); return; }
    if (r.channel === 'network') {
      const c = r.counts;
      console.log(`network — failed=${c.failed} httpError=${c.httpError} hanging=${c.hanging} mixed=${c.mixedContent}`);
      for (const x of r.network.failed) console.log(`  FAIL ${x.method || 'GET'} ${x.url} → ${x.errorText}`);
      for (const x of r.network.httpError) console.log(`  HTTP ${x.status} ${x.method || 'GET'} ${x.url}`);
      for (const x of r.network.hanging) console.log(`  HANG ${x.method || 'GET'} ${x.url}`);
      return;
    }
    for (const e of r.entries || []) console.log(`  ${e.kind}: ${e.text}${e.orig ? `  (${e.orig.file}:${e.orig.line})` : e.loc ? `  (${e.loc})` : ''}`);
    if (r.nextCursor != null) console.log(`… more — next: --since ${r.nextCursor}`);
    if (!r.entries?.length) console.log('(none)');
    return;
  }
  const bits = [r.settled ? 'settled' : `UNSETTLED(${(r.settleWhy || []).join(',')})`, `${r.mutations} mut`];
  if (r.urlChanged) bits.push(`url→ ${r.url}`);
  if (r.console?.length) bits.push(`${r.console.length} console`);
  if (r.dialog) bits.push(`DIALOG ${r.dialog.type}: ${JSON.stringify(r.dialog.message)}`);
  bits.push(`${r.tookMs}ms`);
  console.log(`${verb} ok — ${bits.join(', ')}`);
}

async function runVerb(verb, pos, opts) {
  const session = opts.session || process.env.GLASSBOX_SESSION;
  if (!session) fail({ code: 'BAD_REQUEST', message: 'session required', correction_hint: 'pass -s <session> or set GLASSBOX_SESSION' });
  const d = await ensureDaemon();
  const body = buildBody(verb, pos, opts);
  // verify can run multiple settles + axe + a theme×viewport sweep; give it a much larger budget
  // than a single action so a slow page (or a hanging request under the settle cap) never aborts.
  const ms = verb === 'verify' ? 120000 : 30000;
  const { status, body: resp } = await daemonReq(d, 'POST', `/sessions/${encodeURIComponent(session)}/${verb}`, body, ms);
  if (status !== 200) return fail(resp.error);
  printResult(verb, resp);
}

const VERBS = new Set(['goto', 'click', 'dblclick', 'hover', 'type', 'press', 'scroll', 'observe', 'verify', 'read', 'dialog', 'drag', 'upload', 'select']);

// ---- arg parsing ----------------------------------------------------------

// Flags that consume the next token as their value (kebab on the wire → camel in opts).
const VALUE_FLAGS = {
  '-s': 'session', '--session': 'session', '--color': 'colorScheme', '--base-url': 'baseUrl',
  '--selector': 'selector', '--ref': 'ref', '--testid': 'testid', '--role': 'role', '--name': 'name',
  '--text': 'text', '--url': 'url', '--to': 'to', '--by': 'by', '--key': 'key', '--from': 'from',
  '--files': 'files', '--values': 'values', '--limit': 'limit', '--cursor': 'cursor',
  '--action': 'action', '--timeout': 'timeoutMs',
  '--scope': 'scope', '--channel': 'channel', '--since': 'since', '--theme-attr': 'themeAttr',
};

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') JSON_MODE = true;
    else if (a === '--headed') opts.headed = true;
    else if (a === '--submit') opts.submit = true;
    else if (a === '--themes') opts.themes = true;
    else if (a === '--viewports') opts.viewports = true;
    else if (a === '--no-axe') opts.noAxe = true;
    else if (a === '--no-shots') opts.noShots = true;
    else if (a === '--viewport') {
      const m = /^(\d+)x(\d+)$/.exec(argv[++i] || '');
      if (!m) fail({ code: 'BAD_REQUEST', message: 'bad --viewport, expected WxH e.g. 1280x800' });
      opts.viewport = { width: Number(m[1]), height: Number(m[2]) };
    } else if (VALUE_FLAGS[a]) opts[VALUE_FLAGS[a]] = argv[++i];
    else pos.push(a);
  }
  return { pos, opts };
}

const HELP = `glassbox <command>

  daemon start|stop|status
  session open <name> [--headed] [--viewport WxH] [--color light|dark] [--theme-attr ATTR] [--base-url URL]
  session ls
  session rm <name>
  kill-all

  act/observe (all take -s <session> or GLASSBOX_SESSION):
    goto <url>
    observe [--selector CSS] [--limit N] [--cursor N]
    click|dblclick|hover <css> | --ref eN | --testid ID | --role R [--name N] | --selector CSS | --text T
    type <text> --selector CSS [--submit]        press <key> [--selector CSS]
    scroll [--to top|bottom|CSS|eN] [--by PX]     dialog accept|dismiss [--text T]
    drag --from CSS --to CSS    upload --selector CSS --files a,b    select --selector CSS --values x,y

  verify/read:
    verify [--scope CSS] [--themes] [--viewports] [--no-axe] [--no-shots]
    read [console|network|errors|overlay] [--since N] [--limit N]

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
    if (VERBS.has(verb)) return await runVerb(verb, pos, opts);
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
