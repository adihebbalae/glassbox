#!/usr/bin/env node
// glassboxd — the control plane. A loopback-only HTTP+JSON server (WS/screencast arrives in
// M6) guarding one shared Chromium and its named sessions. Discovery is an atomically-written
// %LOCALAPPDATA%\glassbox\daemon.json; every request needs the 32-byte bearer token. Single
// instance is enforced by the discovery file + a ping/probe liveness check, not a lock file.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  PATHS, VERSION, HOST, CODES, HTTP_STATUS, pingDaemon, probeDaemon,
} from '../protocol.mjs';
import { createSessionManager } from './sessions.mjs';
import { sweepOrphans } from './prockit.mjs';

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
function sendErr(res, code, message, extra = {}) {
  const { code: _c, message: _m, ...rest } = extra;
  send(res, HTTP_STATUS[code] || 500, { error: { code, message, ...rest } });
}

function authed(req) {
  const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
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
  if (!authed(req)) return sendErr(res, CODES.BAD_TOKEN, 'missing or invalid bearer token');
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;
  const method = req.method;
  try {
    if (method === 'GET' && p === '/ping') {
      return send(res, 200, {
        pong: true, pid: process.pid, version: VERSION, startTime: START,
        sessions: mgr.count(), browserLaunched: mgr.browserLaunched(),
      });
    }
    if (method === 'GET' && p === '/probe') {
      return send(res, 200, { ok: true, ...(await mgr.browserProbe()) });
    }
    if (method === 'POST' && p === '/shutdown') {
      send(res, 200, { ok: true });
      setTimeout(() => shutdownFn(0), 20); // let the response flush first
      return;
    }
    if (method === 'POST' && p === '/sessions') {
      const body = await readJson(req);
      return send(res, 200, await mgr.create(body.name, body));
    }
    if (method === 'GET' && p === '/sessions') {
      return send(res, 200, { sessions: mgr.list() });
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

  const mgr = createSessionManager({ idleTtlMs: IDLE_TTL });
  const server = http.createServer((req, res) => handle(req, res, mgr));
  server.on('clientError', (_e, sock) => sock.destroy());
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
