#!/usr/bin/env node
// `glassbox` — the CLI. Verbs map to daemon HTTP routes. Any verb needing the daemon reads
// the discovery file and auto-starts a detached daemon on demand (poll until ping+probe live,
// 15s cap). Human-readable output by default; --json for machine consumers. Stays
// playwright-free (only the daemon imports it) so cold CLI startup is fast.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  PATHS, HTTP_STATUS, daemonReq, pingDaemon, readDaemonFile, clientId,
  ensureDaemon as ensureDaemonShared,
} from './protocol.mjs';
import {
  verifyGlassboxPid, processAlive, taskkillTree, listGlassboxChromium, listGlassboxDaemons, sweepOrphans,
} from './daemon/prockit.mjs';
import { exportReport, latestReport } from './report-html.mjs';
import { KIND, KIND_REASONS, chromiumPath, defaultHeaded, ensureDisplay, probeEgress, HUMAN_CHANNEL } from './platform.mjs';
import { runDev, sweepDevOrphans } from './dev.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let JSON_MODE = false;

// Thrown by fail() to unwind to main(). We set process.exitCode and let the loop drain rather
// than calling process.exit() mid-fetch (see the connection:close note in protocol.mjs).
class ExitSignal extends Error {}

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
    // Who else is in this daemon — printed when a destroy verb refuses (D12).
    for (const g of e.foreign || []) {
      console.error(`  client '${g.client}': ${g.count} session(s) [${g.sessions.join(', ')}], last used ${Math.round(g.idleMs / 1000)}s ago`);
    }
    // …and WHICH daemon answered. A pid that differs from the one your session banner printed means
    // the daemon restarted and took every session with it — one line instead of a journal dig.
    if (e.daemon) {
      const up = new Date(e.daemon.startedAt).toTimeString().slice(0, 8);
      console.error(`  daemon: pid ${e.daemon.pid}, up since ${up} — a different pid than your session banner means it restarted`);
    }
    if (e.correction_hint) console.error(`  hint: ${e.correction_hint}`);
  }
  process.exitCode = 1;
  throw new ExitSignal();
}

// Thin wrapper over the shared auto-start helper: on failure, unwind through fail() (CLI ergonomics)
// instead of letting the structured throw escape to the generic INTERNAL handler.
async function ensureDaemon() {
  try {
    return await ensureDaemonShared();
  } catch (e) {
    fail(e.gb || { code: 'DAEMON_UNREACHABLE', message: e?.message || 'daemon unreachable' });
  }
}

// ---- verbs ----------------------------------------------------------------

async function daemonStart() {
  const d = await ensureDaemon();
  out({ running: true, pid: d.pid, port: d.port }, `daemon running (pid ${d.pid}, port ${d.port})`);
}

async function daemonStop(opts = {}) {
  const d = readDaemonFile();
  if (!d || !(await pingDaemon(d))) return out({ running: false }, 'daemon not running');
  // Stopping the daemon destroys EVERY session in it, including other agents'. Same guard as
  // kill-all: refuse while someone else is using it, unless --force.
  let r;
  try {
    r = await daemonReq(d, 'POST', '/shutdown', { force: !!opts.force }, 8000);
  } catch {
    r = { status: 200, body: {} }; // it may drop the socket as it exits
  }
  if (r.status === HTTP_STATUS.FOREIGN_SESSIONS) return fail(r.body.error);
  if (r.status !== 200 && r.body?.error) return fail(r.body.error);
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

const watchUrlFor = (d, name) => `http://127.0.0.1:${d.port}/watch/${encodeURIComponent(name)}?token=${d.token}`;

async function sessionOpen(name, opts) {
  if (!name) fail({ code: 'BAD_REQUEST', message: 'session name required', correction_hint: 'glassbox session open <name>' });
  const d = await ensureDaemon();
  // `--ignore-404 /favicon.ico` is a leading-slash argument, so Git Bash rewrites it (see D7).
  const req = { name, ...opts, ...(opts.ignore404 ? { ignore404: opts.ignore404.map(unmangleMsysPath) } : {}) };
  const { status, body } = await daemonReq(d, 'POST', '/sessions', req);
  if (status !== 200) return fail(body.error);
  // The watch URL is the human-facing hook the skill promises at open (defect D8) — the MCP face
  // already returned it, the CLI silently didn't.
  const watchUrl = watchUrlFor(d, name);
  const vp = body.viewport ? ` ${body.viewport.width}x${body.viewport.height}` : '';
  // The banner names the OWNER and the DAEMON: the owner is what `kill-all --mine` scopes on, and
  // the daemon pid is the thing to compare against later if sessions start vanishing (D12 + obs).
  const who = body.client ? `, client ${body.client}` : '';
  const dae = body.daemon ? `daemon pid ${body.daemon.pid}` : `daemon pid ${d.pid}`;
  out({ ...body, watchUrl }, `session '${name}' open (${body.headed ? 'headed' : 'headless'}${vp}${who})\n  ${dae}\n  watch: ${watchUrl}`);
}

// D11 — resize an existing session instead of opening a second one and re-seeding its state.
async function sessionResize(name, arg, opts) {
  if (!name) fail({ code: 'BAD_REQUEST', message: 'session name required', correction_hint: 'glassbox session resize <name> 390x844' });
  const m = /^(\d+)x(\d+)$/.exec(arg || '');
  const vp = m ? { width: Number(m[1]), height: Number(m[2]) } : opts.viewport;
  if (!vp) fail({ code: 'BAD_REQUEST', message: 'viewport required as WxH', field: 'viewport', correction_hint: 'glassbox session resize <name> 390x844' });
  const d = await ensureDaemon();
  const { status, body } = await daemonReq(d, 'POST', `/sessions/${encodeURIComponent(name)}/viewport`, vp);
  if (status !== 200) return fail(body.error);
  out(body, `session '${name}' resized to ${body.viewport.width}x${body.viewport.height} (inner ${body.inner?.w}x${body.inner?.h})`);
}

async function sessionLs() {
  const d = await ensureDaemon();
  const { body } = await daemonReq(d, 'GET', '/sessions');
  const rows = body.sessions || [];
  if (JSON_MODE) return out({ sessions: rows, you: clientId() });
  if (!rows.length) return console.log('no sessions');
  const me = clientId();
  for (const s of rows) {
    // The owner column is the whole point of ownership being visible: you can see at a glance
    // which of these a `kill-all --mine` would take, and which belong to someone else.
    const own = s.client === me ? `${s.client} (you)` : s.client;
    console.log(`${s.name}\t${own}\t${s.headed ? 'headed' : 'headless'}\t${s.url || '-'}\tidle ${Math.round(s.idleMs / 1000)}s`);
  }
}

async function sessionRm(name) {
  if (!name) fail({ code: 'BAD_REQUEST', message: 'session name required', correction_hint: 'glassbox session rm <name>' });
  const d = await ensureDaemon();
  const { status, body } = await daemonReq(d, 'DELETE', `/sessions/${encodeURIComponent(name)}`);
  if (status !== 200) return fail(body.error);
  out(body, `session '${name}' removed`);
}

/**
 * The reaper — now with a blast radius the caller chooses (defect D12).
 *   --mine   destroy only the sessions this client opened; leave the daemon (and everyone else's
 *            work) alone unless nothing is left. THE end-of-task cleanup verb.
 *   (bare)   full shutdown, but REFUSED if another client's sessions were used in the last 5 min.
 *   --force  full shutdown plus the machine-wide sweep (strays, cross-daemon). Wedge recovery.
 */
async function killAll(opts = {}) {
  const mine = !!opts.mine;
  const force = !!opts.force;
  const d = readDaemonFile();
  const daemonPid = d?.pid;
  if (d) {
    let r;
    try {
      r = await daemonReq(d, 'POST', '/shutdown', { mine, force }, 20000);
    } catch {
      r = null; // unreachable/dropped socket — fall through to the process-level reaper
    }
    if (r && r.status === HTTP_STATUS.FOREIGN_SESSIONS) return fail(r.body.error);
    if (r && r.status !== 200 && r.body?.error) return fail(r.body.error);
    // --mine with other clients still present: their daemon and browser stay up, so the sweep
    // below (which kills chromium machine-wide) must NOT run.
    if (mine && r?.body && r.body.daemonStopping === false) {
      return out(
        { ok: true, mode: 'mine', client: r.body.client, destroyed: r.body.destroyed, remaining: r.body.remaining, daemonStopped: false },
        `destroyed ${r.body.destroyed.length} session(s) owned by '${r.body.client}'${r.body.destroyed.length ? ` [${r.body.destroyed.join(', ')}]` : ''}; ` +
        `${r.body.remaining} session(s) belonging to other clients remain — daemon left running`
      );
    }
    const dl = Date.now() + 5000;
    while (Date.now() < dl && (await pingDaemon(d))) await delay(150);
  }
  // Force-kill the daemon only after confirming the PID is really ours (PID-reuse guard).
  if (daemonPid && processAlive(daemonPid) && verifyGlassboxPid(daemonPid)) taskkillTree(daemonPid);
  // …and, under --force ONLY, any daemon the discovery file did NOT name. A kill-all that races a
  // starting daemon deletes the file while that daemon lives on, still holding a browser, and every
  // later run then finds chromium it cannot account for — so the reaper must be able to find a
  // daemon the way it finds chromium, by command line, PID-verified. But that also reaches another
  // agent's daemon, so it lives behind --force with the rest of the machine-wide power (D12).
  const daemonStrays = [];
  if (force) {
    for (const pid of listGlassboxDaemons()) {
      if (pid === process.pid || pid === daemonPid) continue;
      if (verifyGlassboxPid(pid) && taskkillTree(pid)) daemonStrays.push(pid);
    }
  }
  const devOrphans = sweepDevOrphans(); // dev servers whose `glassbox dev` died without cleanup
  const before = listGlassboxChromium().length;
  sweepOrphans();
  // WAIT for the kill to land rather than sampling once after a fixed 300ms: `taskkill /T /F`
  // returns immediately while the OS spends seconds tearing a browser's eight processes down, so
  // the fixed delay let kill-all report "chromium 8 -> 0" while they were still alive — and the
  // next proof's precondition then found chromium nobody could explain. Poll until really gone.
  let after = listGlassboxChromium().length;
  const gone = Date.now() + 15000; // generous: it exits the moment the count hits 0, and a reaper
                                   // that returns early is worse than one that takes a few seconds
  while (after > 0 && Date.now() < gone) {
    await delay(250);
    after = listGlassboxChromium().length;
  }
  try {
    fs.unlinkSync(PATHS.daemonFile);
  } catch {
    /* already gone */
  }
  out(
    { ok: true, mode: mine ? 'mine' : force ? 'force' : 'all', daemonPid: daemonPid ?? null, daemonStrays, chromiumBefore: before, chromiumAfter: after, devOrphans },
    `kill-all done${force ? ' (--force, machine-wide)' : ''} — daemon ${daemonPid ?? '(none)'}${daemonStrays.length ? ` (+${daemonStrays.length} stray)` : ''}, chromium ${before} -> ${after}, dev orphans reaped ${devOrphans}`
  );
}

// ---- M6 ride-along watch --------------------------------------------------

// Open a URL in the OS default browser (win32: `cmd /c start`); the empty first arg is `start`'s
// window-title slot. Non-fatal — printing the URL is always the real deliverable.
function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* the printed URL is enough */ }
}

async function watch(name) {
  const d = await ensureDaemon();
  const url = name ? watchUrlFor(d, name) : `http://127.0.0.1:${d.port}/?token=${d.token}`;
  if (!process.env.GLASSBOX_NO_OPEN) openBrowser(url); // tests set this to avoid popping a real tab

  out({ url, session: name || null }, name ? `watching '${name}' → ${url}` : `session grid → ${url}`);
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

/**
 * Git Bash (MSYS) rewrites a leading-slash ARGUMENT into a Windows path before node ever sees it:
 * `--url /planner` arrives as `C:/Program Files/Git/planner`, which is why the documented
 * `for:{url:"/dashboard"}` form "timed out" while `planner` matched (defect D7). A URL pattern is
 * never an absolute Windows path, so recover the intent by stripping the longest prefix that is a
 * real directory on disk — i.e. exactly the MSYS root it prepended.
 */
function unmangleMsysPath(v) {
  if (typeof v !== 'string' || process.platform !== 'win32' || !process.env.MSYSTEM) return v;
  if (!/^[A-Za-z]:[\\/]/.test(v)) return v;
  const parts = v.replace(/\\/g, '/').split('/');
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('/');
    try {
      if (prefix.length > 2 && fs.statSync(prefix).isDirectory()) return '/' + parts.slice(i).join('/');
    } catch { /* not a directory — keep shortening */ }
  }
  return v;
}

function buildBody(verb, pos, opts) {
  const t = buildTarget(verb, pos, opts);
  const timeout = opts.timeoutMs ? { timeoutMs: Number(opts.timeoutMs) } : {};
  const force = opts.force ? { force: true } : {};
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
      ...(opts.noThemeReload ? { themeReload: false } : {}),
      ...(opts.cold ? { cold: true } : {}),
      ...(opts.ignore404?.length ? { ignore404: opts.ignore404.map(unmangleMsysPath) } : {}),
    };
    case 'read': return {
      channel: pos[1] || opts.channel || 'errors',
      ...(opts.since ? { since: Number(opts.since) } : {}),
      ...(opts.limit ? { limit: Number(opts.limit) } : {}),
    };
    case 'drag': return { from: { selector: opts.from }, to: { selector: opts.to }, ...timeout };
    case 'upload': return { ...t, files: (opts.files || '').split(',').filter(Boolean), ...timeout };
    case 'select': return { ...t, values: (opts.values || '').split(',').filter(Boolean), ...timeout };
    case 'settle': return {};
    case 'eval': return { expression: pos[1] || opts.expression || '', ...(opts.awaitPromise ? { awaitPromise: true } : {}) };
    case 'screenshot': return { ...(opts.fullPage ? { fullPage: true } : {}), ...(opts.selector ? { selector: opts.selector } : {}), ...(opts.theme ? { theme: opts.theme } : {}), ...(opts.noForcePaint ? { forcePaint: false } : {}) };
    case 'wait': {
      const f = {};
      if (opts.selector) f.selector = opts.selector;
      else if (opts.text) f.text = opts.text;
      else if (opts.url) f.url = unmangleMsysPath(opts.url);
      else if (opts.hydration) f.hydration = true;
      else if (opts.sleep) f.timeout = Number(opts.sleep);
      return { for: f, ...(opts.timeoutMs ? { timeoutMs: Number(opts.timeoutMs) } : {}) };
    }
    default: return { ...t, ...force, ...timeout }; // click, dblclick, hover
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
    const nav = r.navigation ? ` [${r.navigation.kind.toUpperCase()} load]` : '';
    console.log(`verify ${r.ok ? 'OK' : 'ISSUES'} — ${r.settled ? 'settled' : 'UNSETTLED'}${nav} at ${r.url}`);
    // `consoleErrors`, not `console`: these are console.error entries since the last navigation,
    // not the whole console buffer (dogfood observation — the short name invited misreading).
    console.log(`  counts: consoleErrors=${c.consoleErrors} pageerr=${c.pageErrors} net(failed=${c.netFailed} http=${c.netHttpError} hang=${c.netHanging} mixed=${c.netMixed}) a11y=${c.a11y} layout=${c.layout}`
      + `${c.ignored404 ? ` ignored404=${c.ignored404}` : ''}${c.deferred ? ` deferred=${c.deferred}` : ''}${c.collapsed ? ` collapsed=${c.collapsed}` : ''}`);
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
  if (verb === 'settle') { console.log(`settle — ${r.settled ? 'settled' : `UNSETTLED (${(r.why || []).join(',')})`}`); return; }
  if (verb === 'eval') {
    if (r.threw) console.log(`threw: ${r.error}`);
    else console.log(`${r.value !== undefined ? JSON.stringify(r.value) : r.preview}  (${r.type})`);
    for (const c of r.console || []) console.log(`  ${c.kind}: ${c.text}`);
    return;
  }
  if (verb === 'screenshot') {
    const fp = r.forcedPaint ? `, forced paint on ${r.forcedPaint} deferred container${r.forcedPaint > 1 ? 's' : ''}` : '';
    console.log(`screenshot -> ${r.path}  (${r.bytes} bytes, ${r.w}x${r.h}${fp})`);
    if (r.warning) console.log(`  ! ${r.warning}`);
    return;
  }
  if (verb === 'wait') {
    if (r.slept != null) { console.log(`wait — slept ${r.slept}ms (${r.tookMs}ms)`); return; }
    console.log(`wait — ${r.matched ? 'MATCHED' : 'timed out (matched:false)'} in ${r.tookMs}ms`);
    return;
  }
  if (verb === 'viewport') { console.log(`viewport ${r.viewport.width}x${r.viewport.height} (inner ${r.inner?.w}x${r.inner?.h})`); return; }
  const bits = [r.settled ? 'settled' : `UNSETTLED(${(r.settleWhy || []).join(',')})`, `${r.mutations} mut`];
  if (r.forced) bits.push(`FORCED${r.occludedBy ? ` (through ${r.occludedBy})` : ''}`);
  if (r.note) bits.push(r.note);
  if (r.urlChanged) bits.push(`url→ ${r.url}`);
  // "3 console" then verify's "consoleErrors=1" read as lost messages (both dogfood logs). An
  // action's console delta is EVERY level emitted during that action; say so in the label.
  if (r.console?.length) {
    const errs = r.console.filter((c) => c.kind === 'error' || c.kind === 'pageerror').length;
    bits.push(`${r.console.length} console msg${r.console.length > 1 ? 's' : ''}${errs ? ` (${errs} error${errs > 1 ? 's' : ''})` : ''}`);
  }
  if (r.dialog) bits.push(`DIALOG ${r.dialog.type}: ${JSON.stringify(r.dialog.message)}`);
  bits.push(`${r.tookMs}ms`);
  console.log(`${verb} ok — ${bits.join(', ')}`);
}

// ---- M4 debug/style verbs -------------------------------------------------

function buildDebugBody(op, pos, opts) {
  switch (op) {
    case 'break': return { op, ...(opts.file ? { file: opts.file } : {}), ...(opts.urlRegex ? { urlRegex: opts.urlRegex } : {}), ...(opts.line ? { line: Number(opts.line) } : {}), ...(opts.condition ? { condition: opts.condition } : {}) };
    case 'inspect': return { op, ...(opts.frame ? { frame: Number(opts.frame) } : {}) };
    case 'eval': return { op, expression: pos[2] || opts.expression || '', ...(opts.frame ? { frame: Number(opts.frame) } : {}) };
    case 'step': return { op, mode: pos[2] || opts.mode || 'over' };
    case 'listeners': return { op, ...(opts.ref ? { ref: opts.ref } : { selector: pos[2] || opts.selector }) };
    case 'remove': return { op, ...(opts.all ? { all: true } : { breakpointId: pos[2] || opts.breakpointId }) };
    default: return { op }; // state, resume, pause, list, screenshot, coverage-start, coverage-stop
  }
}

function frameLine(f) {
  const loc = f.orig ? `${f.orig.file}:${f.orig.line}` : `${f.file}:${f.line}`;
  return `  at ${f.functionName}  (${loc})`;
}

function printDebug(op, r) {
  if (JSON_MODE) return out(r);
  if (op === 'state' || op === 'step') {
    if (!r.paused) return console.log(op === 'step' ? 'stepped to completion (resumed)' : 'not paused');
    console.log(`paused (${r.reason})${r.hitBreakpoints?.length ? ' hit ' + r.hitBreakpoints.join(',') : ''}`);
    for (const f of r.frames || []) console.log(frameLine(f));
    return;
  }
  if (op === 'inspect') {
    console.log(`frame ${r.frame}: ${r.functionName}`);
    for (const sc of r.scopes || []) {
      if (!sc.vars.length) continue;
      console.log(`  [${sc.type}${sc.name ? ' ' + sc.name : ''}]`);
      for (const v of sc.vars) console.log(`    ${v.name} = ${v.value}  (${v.type})`);
    }
    return;
  }
  if (op === 'eval') { console.log(r.threw ? `threw: ${r.error}` : (r.value !== undefined ? JSON.stringify(r.value) : r.preview) + `  (${r.type})`); return; }
  if (op === 'resume') { console.log(r.resumed ? 'resumed' : (r.note || 'ok')); return; }
  if (op === 'break') { console.log(`breakpoint ${r.breakpointId} at ${r.file || r.urlRegex}:${r.line}${r.requested && r.requested !== r.line ? ` (requested ${r.requested})` : ''}`); return; }
  if (op === 'list') { if (!r.breakpoints?.length) return console.log('no breakpoints'); for (const b of r.breakpoints) console.log(`  ${b.breakpointId}  ${b.file || b.urlRegex}:${b.line}${b.condition ? ' if ' + b.condition : ''}`); return; }
  if (op === 'remove') { console.log(`removed ${r.removed?.length || 0} breakpoint(s)`); return; }
  if (op === 'screenshot') { console.log(`screenshot -> ${r.path} (${r.bytes} bytes)`); return; }
  if (op === 'listeners') {
    // Always say WHICH element was inspected, and never call an element dead without checking its
    // ancestors for delegation (defect D6).
    const e = r.element;
    if (e) console.log(`inspected ${e.desc}${e.text ? `  "${e.text}"` : ''}${e.visible === false ? '  [not visible]' : ''}`);
    if (r.warning) console.log(`  ! ${r.warning}`);
    for (const L of r.listeners || []) console.log(`  ${L.type}${L.once ? ' once' : ''}${L.capture ? ' capture' : ''}  ${L.sourceLoc || ''}  ${L.source ? '{ ' + L.source + ' }' : ''}`);
    if (!r.count) {
      console.log(`  ${r.verdict || 'no event listeners (dead element)'}`);
      for (const dgt of r.delegated || []) console.log(`    ↑ ${dgt.on} (${dgt.depth} up): ${dgt.types.join(', ')}`);
    }
    return;
  }
  if (op === 'coverage-start') { console.log(`coverage started${r.css ? ' (css tracked)' : ''}`); return; }
  if (op === 'coverage-stop') {
    console.log(`coverage: ${r.js.neverRanCount} never-ran / ${r.js.ranCount} ran; css unused ${r.css.unusedRules ?? '-'}/${r.css.totalRules ?? '-'}`);
    for (const f of r.js.neverRan || []) console.log(`  never ran: ${f.functionName}  (${f.file}:${f.line})`);
    if (r.css.topUnused?.length) console.log(`  unused css: ${r.css.topUnused.slice(0, 6).join(', ')}`);
    console.log(`  report: ${r.report}`);
    return;
  }
  out(r);
}

async function runDebug(pos, opts) {
  const session = opts.session || process.env.GLASSBOX_SESSION;
  if (!session) fail({ code: 'BAD_REQUEST', message: 'session required', correction_hint: 'pass -s <session> or set GLASSBOX_SESSION' });
  const op = pos[1];
  if (!op) fail({ code: 'BAD_REQUEST', message: 'debug needs an op', valid_values: ['break', 'state', 'inspect', 'eval', 'step', 'resume', 'pause', 'listeners', 'coverage-start', 'coverage-stop', 'list', 'remove', 'screenshot'] });
  const d = await ensureDaemon();
  const body = buildDebugBody(op, pos, opts);
  const { status, body: resp } = await daemonReq(d, 'POST', `/sessions/${encodeURIComponent(session)}/debug`, body, 60000);
  if (status !== 200) return fail(resp.error);
  printDebug(op, resp);
}

function printStyle(r) {
  if (JSON_MODE) return out(r);
  const t = r.target.selector || r.target.ref;
  console.log(`style ${t} — ${r.rules} matched rule(s)`);
  const c = r.computed || {};
  console.log('computed: ' + Object.keys(c).map((k) => `${k}:${c[k]}`).join('  '));
  if (r.contrast) console.log(`contrast: ${r.contrast.fg} on ${r.contrast.bg} = ${r.contrast.ratio}:1  ${r.contrast.wcagAA ? '✓' : '✗'} WCAG AA`);
  console.log('cascade (winners first):');
  for (const rule of r.cascade || []) {
    console.log(`  ${rule.selector}  (${rule.source})  [${rule.specificity.join(',')}]`);
    for (const p of rule.properties) console.log(`    ${p.status === 'won' ? '✓' : '✗'} ${p.name}: ${p.value}${p.status === 'overridden' && p.winner ? `  (overridden by ${p.winner})` : ''}`);
  }
  if (r.inherited?.length) { console.log('inherited:'); for (const i of r.inherited) console.log(`  ${i.property}: ${i.value}  ← ${i.from} (${i.source})`); }
  console.log(`[full: ${r.report}]`);
}

async function runStyle(pos, opts) {
  const session = opts.session || process.env.GLASSBOX_SESSION;
  if (!session) fail({ code: 'BAD_REQUEST', message: 'session required', correction_hint: 'pass -s <session> or set GLASSBOX_SESSION' });
  const body = opts.ref ? { ref: opts.ref } : { selector: pos[1] || opts.selector };
  if (!body.ref && !body.selector) fail({ code: 'BAD_REQUEST', message: 'style needs a selector or --ref', correction_hint: 'glassbox style "#el" -s <session>' });
  const d = await ensureDaemon();
  const { status, body: resp } = await daemonReq(d, 'POST', `/sessions/${encodeURIComponent(session)}/style`, body, 30000);
  if (status !== 200) return fail(resp.error);
  printStyle(resp);
}

async function runVerb(verb, pos, opts) {
  const session = opts.session || process.env.GLASSBOX_SESSION;
  if (!session) fail({ code: 'BAD_REQUEST', message: 'session required', correction_hint: 'pass -s <session> or set GLASSBOX_SESSION' });
  const d = await ensureDaemon();
  const body = buildBody(verb, pos, opts);
  // verify can run multiple settles + axe + a theme×viewport sweep (each theme leg reloads); give
  // it a much larger budget than a single action so a slow page never aborts. A `wait` owns its own
  // budget — the HTTP call must outlive the sleep it asked for, or the client aborts a healthy wait.
  let ms = verb === 'verify' ? 180000 : 30000;
  if (verb === 'wait') ms = Math.max(30000, (Number(opts.sleep) || 0) + 20000, (Number(opts.timeoutMs) || 0) + 20000);
  const { status, body: resp } = await daemonReq(d, 'POST', `/sessions/${encodeURIComponent(session)}/${verb}`, body, ms);
  if (status !== 200) return fail(resp.error);
  printResult(verb, resp);
}

// `export` is CLI-local on purpose: it reads an on-disk report, so it needs no daemon, no browser
// and no session still alive. You can export yesterday's run.
async function runExport(pos, opts) {
  const name = opts.session || pos[0];
  if (!name) fail({ code: 'BAD_REQUEST', message: 'export needs a session: glassbox export -s <session> [--out file.html]', field: 'session' });
  const rp = latestReport(PATHS.sessions, name);
  if (!rp) fail({ code: 'NO_SESSION', message: `no verify report on disk for session '${name}'`, correction_hint: 'run `glassbox verify -s ' + name + '` first — export reads the report it writes' });
  const res = exportReport(rp, { out: opts.out ? unmangleMsysPath(opts.out) : null });
  out({ ...res, from: rp }, `exported ${res.findings} finding(s) → ${res.path}  (${Math.round(res.bytes / 1024)}kb, self-contained)`);
}

/**
 * `doctor` — what this machine will and will not let glassbox measure, before you build anything on
 * top of it. Every line is a MEASUREMENT, not a guess: it finds the browser, brings up a display if
 * one is needed, and probes egress for real. In a container the answers change what a report means,
 * so the report states them; doctor is the same information ahead of time.
 */
async function runDoctor() {
  const chrome = chromiumPath();
  const headed = defaultHeaded();
  const display = ensureDisplay(headed);
  const egress = await probeEgress({ cacheFile: PATHS.egressCache }).catch(() => ({ state: 'unknown', detail: 'probe threw' }));
  const d = {
    platform: KIND,
    detectedBy: KIND_REASONS,
    stateRoot: PATHS.root,
    browser: chrome.path || 'playwright channel:chromium',
    browserVia: chrome.why,
    defaultMode: headed ? display.display : 'headless',
    ...(display.downgraded ? { displayDowngraded: display.downgraded } : {}),
    egress: egress.state,
    egressDetail: egress.detail,
    humanChannel: HUMAN_CHANNEL,
  };
  if (JSON_MODE) { out(d, ''); return; }
  const pad = (k) => (k + ' '.repeat(18)).slice(0, 18);
  const say = (line) => out(d, line);
  for (const [k, v] of Object.entries(d)) say(`${pad(k)} ${Array.isArray(v) ? v.join(', ') : v}`);
  if (d.egress === 'jailed') {
    say('');
    say('Egress is jailed: the browser cannot load web fonts, CDN scripts or third-party APIs.');
    say('verify will class those as `sandboxBlocked` (info, never a defect) — but a page whose');
    say('typeface never loaded gives text-metric findings about a render nobody else will see.');
    say('Record a HAR where the network works, replay it here:');
    say('  networked:  glassbox session open s --record-har run.har  …  glassbox session close s');
    say('  sandbox:    glassbox session open s --har run.har');
  }
  if (!chrome.path && KIND !== 'win32') {
    say('');
    say('No chromium found on disk. Set GLASSBOX_CHROMIUM=/path/to/chrome, or install one —');
    say('note that `npx playwright install` needs network the sandbox allowlist may not permit.');
  }
}

const VERBS = new Set(['goto', 'click', 'dblclick', 'hover', 'type', 'press', 'scroll', 'observe', 'verify', 'read', 'dialog', 'drag', 'upload', 'select', 'settle', 'eval', 'screenshot', 'wait']);

// ---- M5 artifacts (GET) + mcp shim ----------------------------------------

async function runArtifacts(opts) {
  const session = opts.session || process.env.GLASSBOX_SESSION;
  if (!session) fail({ code: 'BAD_REQUEST', message: 'session required', correction_hint: 'pass -s <session> or set GLASSBOX_SESSION' });
  const d = await ensureDaemon();
  const { status, body } = await daemonReq(d, 'GET', `/sessions/${encodeURIComponent(session)}/artifacts`);
  if (status !== 200) return fail(body.error);
  if (JSON_MODE) return out(body);
  console.log(`artifacts for '${session}'  (${body.dir})`);
  for (const kind of ['shots', 'reports', 'net', 'journal']) {
    const files = body.artifacts?.[kind] || [];
    console.log(`  ${kind}: ${files.length} file(s)`);
    for (const f of files.slice(0, 10)) console.log(`    ${f.rel}\t${f.bytes}b`);
  }
}

// ---- M7 dev loop ----------------------------------------------------------

// Long-running and streaming, so it owns stdout for its lifetime; structured failures unwind
// through fail() like every other verb. CLI-only on purpose (see the header of dev.mjs).
async function runDevVerb(opts) {
  try {
    await runDev(opts, JSON_MODE);
  } catch (e) {
    fail(e.gb || { code: 'INTERNAL', message: e?.message || String(e) });
  }
}

async function runMcp() {
  const { runShim } = await import('./mcp-shim.mjs');
  runShim(); // takes over stdin/stdout — becomes the MCP server for its lifetime
}

// ---- arg parsing ----------------------------------------------------------

// Flags that consume the next token as their value (kebab on the wire → camel in opts).
const VALUE_FLAGS = {
  '-s': 'session', '--session': 'session', '--color': 'colorScheme', '--base-url': 'baseUrl',
  '--client': 'client',
  '--selector': 'selector', '--ref': 'ref', '--testid': 'testid', '--role': 'role', '--name': 'name',
  '--text': 'text', '--url': 'url', '--to': 'to', '--by': 'by', '--key': 'key', '--from': 'from',
  '--files': 'files', '--values': 'values', '--limit': 'limit', '--cursor': 'cursor',
  '--action': 'action', '--timeout': 'timeoutMs',
  '--scope': 'scope', '--channel': 'channel', '--since': 'since',
  '--theme-attr': 'themeAttr', '--theme-class': 'themeClass',
  // M7 dev loop ('--timeout' doubles as dev's startup budget, in SECONDS — see dev.mjs)
  '--cmd': 'cmd', '--cwd': 'cwd',
  // M4 debug/style
  '--file': 'file', '--line': 'line', '--condition': 'condition', '--url-regex': 'urlRegex',
  '--frame': 'frame', '--expression': 'expression', '--mode': 'mode', '--breakpoint': 'breakpointId',
  // M5 eval/screenshot/wait
  '--theme': 'theme', '--sleep': 'sleep',
  // Sandbox backend: the HAR fidelity bridge plus explicit environment pinning. --har replays a
  // recording made on a networked machine, so web fonts and API responses exist in a container
  // that cannot reach either; --record-har makes one. See src/daemon/stubs.mjs for why this is
  // the load-bearing piece of the sandbox backend.
  '--har': 'har', '--har-not-found': 'harNotFound', '--har-url': 'harUrl', '--record-har': 'recordHar',
  '--timezone': 'timezone', '--locale': 'locale', '--out': 'out',
};

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') JSON_MODE = true;
    else if (a === '--headed') opts.headed = true;
    // Headed is the SANDBOX default: a headless container reports a 0px overlay scrollbar and so
    // cannot see horizontal overflow at all, while headed-under-Xvfb reports the same 15px gutter
    // Windows Chrome does. --headless is the opt-out.
    else if (a === '--headless') opts.headless = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--submit') opts.submit = true;
    else if (a === '--themes') opts.themes = true;
    else if (a === '--viewports') opts.viewports = true;
    else if (a === '--no-axe') opts.noAxe = true;
    else if (a === '--no-shots') opts.noShots = true;
    else if (a === '--no-theme-reload') opts.noThemeReload = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--cold') opts.cold = true;
    else if (a === '--mine') opts.mine = true;
    else if (a === '--no-force-paint') opts.noForcePaint = true;
    else if (a === '--ignore-404') (opts.ignore404 ||= []).push(argv[++i]); // repeatable
    else if (a === '--full') opts.fullPage = true;
    else if (a === '--hydration') opts.hydration = true;
    else if (a === '--await') opts.awaitPromise = true;
    else if (a === '--no-attach') opts.noAttach = true;
    else if (a === '--auto-verify') opts.autoVerify = true;
    else if (a === '--viewport') {
      const m = /^(\d+)x(\d+)$/.exec(argv[++i] || '');
      if (!m) fail({ code: 'BAD_REQUEST', message: 'bad --viewport, expected WxH e.g. 1280x800' });
      opts.viewport = { width: Number(m[1]), height: Number(m[2]) };
    } else if (VALUE_FLAGS[a]) opts[VALUE_FLAGS[a]] = argv[++i];
    else pos.push(a);
  }
  return { pos, opts };
}

const HELP = `glassbox <command>   ·   CLI = MCP tools = same daemon. [--json] on any command for machine output.

ENVIRONMENT
  doctor                        (what this box will and won't let glassbox measure: browser,
                                 display mode, egress, state root — all probed, none guessed)
  export -s <session> [--out f] (latest verify report -> one self-contained .html; needs no daemon,
                                 no browser and no live session — the sandbox stand-in for watch)

SESSIONS
  daemon start|stop|status
  session open <name> [--headed] [--viewport WxH] [--color light|dark] [--base-url URL]
                      [--theme-attr ATTR] [--theme-class CLASS]   (the site's own theme switch)
                      [--ignore-404 /path]                        (repeatable; expected 404s)
  session ls                  session rm <name>
  session resize <name> WxH   (alias: set-viewport — no need to re-open + re-seed for mobile)
  artifacts -s <session>      (list on-disk shots/reports/net/journal)
  kill-all --mine             (YOUR sessions only — the normal end-of-task cleanup)
  kill-all                    (whole daemon; REFUSES while another client is using it)
  kill-all --force            (machine-wide clean slate: every session, every glassbox chromium,
                               every glassbox daemon — including other agents' live work)
  mcp                         (run the stdio MCP server — put this in .mcp.json)

  ONE daemon serves every agent on this machine, so sessions are OWNED. Identify yourself with
  --client <id> or GLASSBOX_CLIENT (the MCP shim does it automatically); 'session ls' shows owners.

NAVIGATE + ACT   (all take -s <session> or GLASSBOX_SESSION)
  goto <url>
  click|dblclick|hover <css> | --ref eN | --testid ID | --role R [--name N] | --selector CSS | --text T
      [--force]   (click even when something covers the target; recorded as forced:true)
  type <text> --selector CSS [--submit]        press <key> [--selector CSS]
  scroll [--to top|bottom|CSS|eN] [--by PX]     dialog accept|dismiss [--text T]
  drag --from CSS --to CSS     upload --selector CSS --files a,b     select --selector CSS --values x,y
  eval "<expr>" [--await]      wait [--selector CSS | --text T | --url U | --hydration | --sleep MS] [--timeout MS]

OBSERVE + VERIFY
  observe [--selector CSS] [--limit N] [--cursor N]
  verify [--scope CSS] [--themes] [--viewports] [--no-axe] [--no-shots] [--no-theme-reload]
         [--cold] [--ignore-404 /path]
      --cold re-navigates cache-cleared first: first-load CLS and first-request 404s are only
      honest on a COLD load. Every report says which one it measured.
  read [console|network|errors|overlay] [--since N] [--limit N]
  screenshot|shot [--full] [--selector CSS] [--theme light|dark] [--no-force-paint]
      --full forces content-visibility:auto sections to paint first (else they stitch in blank)
  settle                       (block until the page quiesces)

DEBUG   (white-box; -s <session>)
  debug break --file app.js --line N [--condition EXPR] | --url-regex RE --line N
  debug state | inspect [--frame N] | eval "<expr>" [--frame N]
  debug step [over|into|out] | resume | pause | screenshot
  debug listeners <css> | --ref eN            debug list | remove <bpId> | remove --all
  debug coverage-start … coverage-stop
  style <css> | --ref eN                       (why-does-this-look-wrong: cascade + contrast)

WATCH
  watch [session]              (live screencast + takeover page; no arg = session grid)

DEV LOOP
  dev [--cmd "npm run dev"] [--cwd DIR] [-s SESSION] [--timeout SECONDS] [--no-attach] [--auto-verify]
      Spawns your dev server, finds its ready URL in its own output, attaches session 'dev',
      runs one verify, then streams: each rebuild is journaled and the build-error overlay
      re-read. q + Enter (or Ctrl-C) stops the server. --no-attach = print the URL and exit.`;

async function main() {
  try {
    const { pos, opts } = parseArgs(process.argv.slice(2));
    const [verb, sub, arg] = pos;
    // `--client` outranks GLASSBOX_CLIENT for this invocation. Written into the env before any
    // request so the single place that stamps the header (protocol.daemonReq) needs no argument.
    if (opts.client) process.env.GLASSBOX_CLIENT = String(opts.client);
    // Asking for help is a success; an unknown verb (the fallthrough at the bottom) is not.
    if (!verb || verb === 'help' || verb === '--help' || verb === '-h') return console.log(HELP);
    if (verb === 'daemon' && sub === 'start') return await daemonStart();
    if (verb === 'daemon' && sub === 'stop') return await daemonStop(opts);
    if (verb === 'daemon' && sub === 'status') return await daemonStatus();
    if (verb === 'session' && sub === 'open') return await sessionOpen(arg, opts);
    if (verb === 'session' && (sub === 'ls' || sub === 'list')) return await sessionLs();
    if (verb === 'session' && (sub === 'rm' || sub === 'close')) return await sessionRm(arg);
    if (verb === 'session' && (sub === 'resize' || sub === 'set-viewport')) return await sessionResize(arg, pos[3], opts);
    if (verb === 'kill-all') return await killAll(opts);
    if (verb === 'watch') return await watch(sub);
    if (verb === 'dev') return await runDevVerb(opts);
    if (verb === 'mcp') return await runMcp();
    if (verb === 'artifacts') return await runArtifacts(opts);
    if (verb === 'export') return await runExport(pos.slice(1), opts);
    if (verb === 'doctor') return await runDoctor();
    if (verb === 'debug') return await runDebug(pos, opts);
    if (verb === 'style') return await runStyle(pos, opts);
    if (verb === 'shot') return await runVerb('screenshot', pos, opts); // alias
    if (VERBS.has(verb)) return await runVerb(verb, pos, opts);
    console.error(`unknown command '${verb}'`);
    console.log(HELP);
    process.exitCode = 1;
  } catch (e) {
    if (e instanceof ExitSignal) return; // exitCode already set, message already printed
    console.error(`error [INTERNAL]: ${e?.message || e}`);
    if (JSON_MODE) console.log(JSON.stringify({ error: { code: 'INTERNAL', message: e?.message || String(e) } }));
    process.exitCode = 1;
  }
}

main();
