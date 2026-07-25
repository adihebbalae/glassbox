// Shared contract between daemon, cli, and the mcp shim: error codes, the structured error
// shape, runtime paths, a tiny authed HTTP client for the control plane, and the auto-start
// helper both faces (CLI + MCP shim) use to reach a live daemon. Only cheap Node builtins here
// (path/fs/child_process/url) — cli.mjs and the shim must stay playwright-free for fast startup.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';
export const HOST = '127.0.0.1';

const ROOT = path.join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'glassbox');
export const PATHS = Object.freeze({
  root: ROOT,
  daemonFile: path.join(ROOT, 'daemon.json'),
  sessions: path.join(ROOT, 'sessions'),
  chromeData: path.join(ROOT, 'chrome-data'),
});

// Every glassbox-launched chromium carries `...\glassbox\chrome-data\...` in its command
// line via --user-data-dir; the orphan sweep matches on this marker (never a bare PID).
export const CHROME_MARKER = 'glassbox';

export const CODES = Object.freeze({
  NO_SESSION: 'NO_SESSION',
  DUP_SESSION: 'DUP_SESSION',
  DAEMON_UNREACHABLE: 'DAEMON_UNREACHABLE',
  BAD_TOKEN: 'BAD_TOKEN',
  BAD_REQUEST: 'BAD_REQUEST',
  INTERNAL: 'INTERNAL',
  // M2 — act + observe
  STALE_REF: 'STALE_REF', // a ref outlived its snapshot; re-observe
  NO_TARGET: 'NO_TARGET', // selector/testid/role/text/ref matched nothing
  ACT_TIMEOUT: 'ACT_TIMEOUT', // Playwright actionability check unmet within the per-action budget
  ACT_OCCLUDED: 'ACT_OCCLUDED', // another element covers the target's hit point; a real pointer can't reach it
  DIALOG_PENDING: 'DIALOG_PENDING', // a native dialog must be answered before other actions proceed
  NO_DIALOG: 'NO_DIALOG', // dialog responder called with nothing pending
  // M3 — verification engine
  BAD_CHANNEL: 'BAD_CHANNEL', // read() got a channel that isn't console|network|errors|overlay
  // M4 — white-box debug plane
  PAUSED: 'PAUSED', // the session is paused at a breakpoint; resume or use debug tools, don't hang
  // M7 — dev-loop
  DEV_NO_URL: 'DEV_NO_URL', // the dev command printed no ready URL (or died) inside the budget
});

export const HTTP_STATUS = Object.freeze({
  NO_SESSION: 404,
  DUP_SESSION: 409,
  DAEMON_UNREACHABLE: 503,
  BAD_TOKEN: 401,
  BAD_REQUEST: 400,
  INTERNAL: 500,
  STALE_REF: 409,
  NO_TARGET: 404,
  ACT_TIMEOUT: 504,
  ACT_OCCLUDED: 409,
  DIALOG_PENDING: 409,
  NO_DIALOG: 409,
  BAD_CHANNEL: 400,
  PAUSED: 409,
  DEV_NO_URL: 504,
});

/**
 * Build an Error carrying the structured wire shape on `.gb`
 * ({code, message, field?, correction_hint?, valid_values?}). The daemon serializes `.gb`.
 */
export function gbErr(code, message, extra = {}) {
  const e = new Error(message);
  e.gb = { code, message, ...extra };
  return e;
}

/** One authed round-trip to the daemon. Returns {status, body}; never throws on HTTP status. */
export async function daemonReq(d, method, route, body, ms = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  // `connection: close` — refuse undici's keep-alive pool so a short-lived CLI's event loop
  // drains promptly after the response (and never trips libuv's UV_HANDLE_CLOSING assertion
  // on a race between process exit and socket teardown on Windows).
  const opts = { method, headers: { authorization: `Bearer ${d.token}`, connection: 'close' }, signal: ctrl.signal };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(`http://${HOST}:${d.port}${route}`, opts);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    clearTimeout(timer);
  }
}

/** Liveness handshake — a bare TCP connect is NOT trusted (research 07 §9). */
export async function pingDaemon(d) {
  try {
    const { status, body } = await daemonReq(d, 'GET', '/ping', undefined, 4000);
    return status === 200 && body.pong === true && body.pid === d.pid;
  } catch {
    return false;
  }
}

/** Depth probe — round-trips to Chromium (launches the shared browser if needed). */
export async function probeDaemon(d) {
  try {
    const { status, body } = await daemonReq(d, 'GET', '/probe', undefined, 20000);
    return status === 200 && body.ok === true;
  } catch {
    return false;
  }
}

// The daemon entry, resolved once as a path string (NOT an import — no cycle: daemon.mjs imports
// this file, this file only spawns it by path).
const DAEMON_ENTRY = fileURLToPath(new URL('./daemon/daemon.mjs', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read the discovery file, or null if absent/unreadable. */
export function readDaemonFile() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Ensure a live daemon and return its {port, token, pid, ...} descriptor. Fast path: a pingable
 * discovery file. Otherwise spawn a detached daemon and poll ping+probe until live (15s cap).
 * Throws a structured gbErr(DAEMON_UNREACHABLE) on failure — the CLI turns that into an exit, the
 * MCP shim into an isError result. Shared so both faces auto-start identically.
 */
export async function ensureDaemon() {
  const existing = readDaemonFile();
  if (existing && (await pingDaemon(existing))) return existing; // fast path
  spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await delay(200);
    const d = readDaemonFile();
    if (d && (await pingDaemon(d)) && (await probeDaemon(d))) return d;
  }
  throw gbErr(CODES.DAEMON_UNREACHABLE, 'daemon did not become live within 15s', {
    correction_hint: 'check for a crashed daemon (glassbox daemon status) or run glassbox kill-all',
  });
}
