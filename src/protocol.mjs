// Shared contract between daemon, cli, and the (future) mcp shim: error codes, the
// structured error shape, runtime paths, and a tiny authed HTTP client for the control
// plane. No heavy imports here — cli.mjs must stay playwright-free for fast startup.
import path from 'node:path';

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
});

export const HTTP_STATUS = Object.freeze({
  NO_SESSION: 404,
  DUP_SESSION: 409,
  DAEMON_UNREACHABLE: 503,
  BAD_TOKEN: 401,
  BAD_REQUEST: 400,
  INTERNAL: 500,
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
