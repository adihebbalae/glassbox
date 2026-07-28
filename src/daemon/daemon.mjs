#!/usr/bin/env node
// glassboxd — the control plane. A loopback-only HTTP+JSON server (WS/screencast arrives in
// M6) guarding one shared Chromium and its named sessions. Discovery is an atomically-written
// %LOCALAPPDATA%\glassbox\daemon.json; every request needs the 32-byte bearer token. Single
// instance is enforced by the discovery file + a ping/probe liveness check, not a lock file.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  PATHS, VERSION, HOST, CODES, HTTP_STATUS, CLIENT_HEADER, ANON_CLIENT, pingDaemon, probeDaemon,
} from '../protocol.mjs';
import { createSessionManager } from './sessions.mjs';
import { handleAction } from './actions.mjs';
import { listArtifacts } from './extras.mjs';
import { handleDebug } from './debug.mjs';
import { handleStyle } from './style.mjs';
import { handleWatchUpgrade } from './screencast.mjs';
import { gridPage, watchPage } from './watch-page.mjs';
import { sweepOrphans } from './prockit.mjs';
import { probeEgress, describePlatform } from '../platform.mjs';

const TOKEN = crypto.randomBytes(32).toString('hex');
const START = Date.now();
const IDLE_TTL = Number(process.env.GLASSBOX_IDLE_TTL_MS) || 30 * 60 * 1000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let shutdownFn = () => process.exit(0);

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}
function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}
function sendErr(res, code, message, extra = {}) {
  const { code: _c, message: _m, ...rest } = extra;
  send(res, HTTP_STATUS[code] || 500, { error: { code, message, ...rest } });
}

function tokenOk(tok) {
  if (!tok) return false;
  const got = Buffer.from(tok);
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Accept the bearer header (CLI/MCP/tests) OR a ?token= query param — browsers navigating to the
// watch page and opening the screencast WS can't set an Authorization header.
function authed(req, url) {
  const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
  if (m && tokenOk(m[1])) return true;
  return tokenOk(url?.searchParams.get('token'));
}

/** The caller's identity, from the header every daemonReq sets (default: anonymous). */
function clientOf(req) {
  const raw = req.headers[CLIENT_HEADER];
  return String((Array.isArray(raw) ? raw[0] : raw) || ANON_CLIENT).slice(0, 64) || ANON_CLIENT;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1 << 20) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { gb: { code: CODES.BAD_REQUEST, message: 'invalid JSON body' } }));
      }
    });
    req.on('error', reject);
  });
}

async function handle(req, res, mgr) {
  const url = new URL(req.url, `http://${HOST}`);
  if (!authed(req, url)) return sendErr(res, CODES.BAD_TOKEN, 'missing or invalid bearer token');
  const p = url.pathname;
  const method = req.method;
  const token = url.searchParams.get('token') || TOKEN; // for self-referential links in served HTML
  try {
    // Ride-along pages (M6): the session grid and the per-session live watcher (auth via ?token=).
    if (method === 'GET' && p === '/') return sendHtml(res, gridPage({ token, sessions: mgr.list() }));
    const wm = /^\/watch\/([^/]+)$/.exec(p);
    if (wm && method === 'GET') {
      const name = decodeURIComponent(wm[1]);
      let cdp = null;
      try { cdp = mgr.cdpInfo(name); } catch { /* unknown session — still render the shell */ }
      return sendHtml(res, watchPage({ session: name, token, cdp }));
    }
    if (method === 'GET' && p === '/ping') {
      return send(res, 200, {
        pong: true, pid: process.pid, version: VERSION, startTime: START,
        sessions: mgr.count(), browserLaunched: mgr.browserLaunched(),
      });
    }
    if (method === 'GET' && p === '/probe') {
      return send(res, 200, { ok: true, ...(await mgr.browserProbe()) });
    }
    // The destructive verb. One daemon serves every agent on the machine, so it has to answer
    // "whose sessions am I about to destroy?" BEFORE destroying them (D12):
    //   {mine:true}  → only the caller's; the daemon stays up while anyone else still has one
    //   {}           → full shutdown, REFUSED with FOREIGN_SESSIONS if another client is still in it
    //   {force:true} → full shutdown regardless (wedge recovery — the blast radius is the point)
    if (method === 'POST' && p === '/shutdown') {
      const body = await readJson(req);
      const client = clientOf(req);
      if (body.mine) {
        const destroyed = await mgr.destroyMine(client);
        const remaining = mgr.count();
        const stopping = remaining === 0;
        send(res, 200, { ok: true, mode: 'mine', client, destroyed, remaining, daemonStopping: stopping });
        if (stopping) setTimeout(() => shutdownFn(0), 20);
        return;
      }
      const foreign = body.force ? [] : mgr.foreignActive(client);
      if (foreign.length) {
        const total = foreign.reduce((n, g) => n + g.count, 0);
        return sendErr(res, CODES.FOREIGN_SESSIONS,
          `refusing to shut down: ${total} session(s) owned by ${foreign.length} other client(s) were in use within the last 5 minutes`, {
            field: 'force',
            foreign,
            correction_hint: 'use `kill-all --mine` to destroy only your own sessions (the normal end-of-task cleanup), `session rm <name>` for a single one, or `--force` if you really do mean to take down everyone else\'s work',
          });
      }
      send(res, 200, { ok: true, mode: body.force ? 'force' : 'all', client });
      setTimeout(() => shutdownFn(0), 20); // let the response flush first
      return;
    }
    if (method === 'POST' && p === '/sessions') {
      const body = await readJson(req);
      return send(res, 200, await mgr.create(body.name, { ...body, client: body.client || clientOf(req) }));
    }
    if (method === 'GET' && p === '/sessions') {
      return send(res, 200, { sessions: mgr.list() });
    }
    // M5: GET /sessions/:name/artifacts — list on-disk artifacts grouped by kind (no queue needed).
    const am = /^\/sessions\/([^/]+)\/artifacts$/.exec(p);
    if (am && method === 'GET') return send(res, 200, listArtifacts(mgr._get(decodeURIComponent(am[1]))));
    // M2 action verbs + M4 debug/style + M5 eval/screenshot/wait: POST /sessions/:name/<verb>.
    // /probe stays with the M1 handler below (excluded here).
    const mv = /^\/sessions\/([^/]+)\/([a-z]+)$/.exec(p);
    if (mv && method === 'POST' && mv[2] !== 'probe') {
      const name = decodeURIComponent(mv[1]);
      const body = await readJson(req);
      if (mv[2] === 'debug') return send(res, 200, await handleDebug(mgr, name, body));
      if (mv[2] === 'style') return send(res, 200, await handleStyle(mgr, name, body));
      return send(res, 200, await handleAction(mgr, name, mv[2], body));
    }
    const m = /^\/sessions\/([^/]+)(\/probe)?$/.exec(p);
    if (m) {
      const name = decodeURIComponent(m[1]);
      if (m[2] === '/probe' && method === 'POST') return send(res, 200, await mgr.probe(name));
      if (method === 'GET') return send(res, 200, mgr.info(name));
      if (method === 'DELETE') return send(res, 200, await mgr.destroy(name));
    }
    return sendErr(res, CODES.BAD_REQUEST, `no route for ${method} ${p}`);
  } catch (e) {
    if (e && e.gb) return sendErr(res, e.gb.code, e.gb.message, e.gb);
    return sendErr(res, CODES.INTERNAL, e?.message || 'internal error');
  }
}

function writeDaemonFile(obj) {
  const tmp = `${PATHS.daemonFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, PATHS.daemonFile); // atomic replace
}

function removeDaemonFileIfOurs() {
  try {
    const d = JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8'));
    if (d.pid === process.pid) fs.unlinkSync(PATHS.daemonFile);
  } catch {
    /* nothing to remove */
  }
}

/** Exit unless we're the sole daemon: if the discovery file points at a live one, step aside. */
async function ensureSingleInstance() {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8'));
  } catch {
    return; // no (readable) discovery file — we are it
  }
  if ((await pingDaemon(d)) && (await probeDaemon(d))) {
    console.error(`glassbox daemon already running (pid ${d.pid}, port ${d.port}); exiting`);
    process.exit(0);
  }
  // stale file (dead pid / reused port / wrong token) — we'll atomically overwrite it
}

async function main() {
  await ensureSingleInstance();
  try {
    sweepOrphans(); // reap chromium left by a crashed prior daemon (we're now the sole instance)
  } catch {
    /* best effort */
  }
  fs.mkdirSync(PATHS.root, { recursive: true });
  fs.mkdirSync(PATHS.sessions, { recursive: true });

  // Measure egress once, at startup, before any session exists. A verify report has to state
  // whether outbound traffic was open or jailed, and the honest way to know is to check — an agent
  // sandbox refuses everything outside its package-registry allowlist, and guessing that from
  // environment variables would be a claim the instrument cannot back. Cached with a TTL; a
  // failure to probe leaves the state 'jailed', which is the conservative answer (it demotes
  // external failures to info rather than inventing defects).
  await probeEgress({ cacheFile: PATHS.egressCache }).catch(() => {});

  const mgr = createSessionManager({ idleTtlMs: IDLE_TTL, startTime: START });
  const server = http.createServer((req, res) => handle(req, res, mgr));
  server.on('clientError', (_e, sock) => sock.destroy());
  // WebSocket upgrades: only /watch/:session, authed via ?token= (browsers can't set headers).
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, `http://${HOST}`);
      if (!authed(req, url)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      const wm = /^\/watch\/([^/]+)$/.exec(url.pathname);
      if (!wm) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      handleWatchUpgrade(mgr, decodeURIComponent(wm[1]), req, socket, head);
    } catch { try { socket.destroy(); } catch { /* gone */ } }
  });
  await new Promise((r) => server.listen(0, HOST, r));
  const { port } = server.address();

  writeDaemonFile({ port, token: TOKEN, pid: process.pid, startTime: START, version: VERSION });

  const gc = setInterval(() => mgr.gcTick(), 60000);
  gc.unref();

  let closing = false;
  shutdownFn = async (code = 0) => {
    if (closing) return;
    closing = true;
    clearInterval(gc);
    try {
      await Promise.race([mgr.shutdown(), delay(6000)]);
    } catch {
      /* Playwright's taskkill /T /F is the backstop; kill-all sweeps any escapee */
    }
    removeDaemonFileIfOurs();
    server.close();
    process.exit(code);
  };
  process.on('SIGINT', () => shutdownFn(0));
  process.on('SIGTERM', () => shutdownFn(0)); // Windows delivers these unreliably — /shutdown is the real path

  console.error(`glassbox daemon listening on ${HOST}:${port} pid=${process.pid}`);
}

main().catch((e) => {
  console.error('daemon failed to start:', e?.stack || e);
  removeDaemonFileIfOurs();
  process.exit(1);
});
