// SessionManager: named BrowserContexts in one shared Chromium (arch §1/§2). Sessions are
// created lazily against a persistent-context browser whose --user-data-dir lives under
// %LOCALAPPDATA%\glassbox\chrome-data\ (so the reaper can find strays). Headless is the
// shared default; a second headed browser is launched on demand. Every session owns a
// context + page + CDP session + artifact dir, and a SERIAL command queue so commands
// within a session never interleave while different sessions run fully parallel.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { PATHS, CODES, gbErr } from '../protocol.mjs';
import { createJournal } from './journal.mjs';

const NAME_RE = /^[\w.-]{1,64}$/;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function createSessionManager({ idleTtlMs = 30 * 60 * 1000 } = {}) {
  /** name -> session record */
  const sessions = new Map();
  // Persistent contexts keyed by mode; each .browser() is the shared handle we spawn sessions on.
  const persistent = { headless: null, headed: null };
  const launching = { headless: null, headed: null };

  async function ensureBrowser(headed) {
    const key = headed ? 'headed' : 'headless';
    if (persistent[key]) return persistent[key].browser();
    if (!launching[key]) {
      const udd = path.join(PATHS.chromeData, key);
      fs.mkdirSync(udd, { recursive: true });
      launching[key] = chromium
        .launchPersistentContext(udd, { channel: 'chromium', headless: !headed })
        .then((ctx) => {
          persistent[key] = ctx;
          for (const p of ctx.pages()) p.close().catch(() => {}); // drop the default about:blank tab
          return ctx;
        })
        .catch((err) => {
          launching[key] = null; // don't poison the mode — let the next create retry a transient failure
          throw err;
        });
    }
    return (await launching[key]).browser();
  }

  function get(name) {
    const s = sessions.get(name);
    if (!s || !s.context) {
      throw gbErr(CODES.NO_SESSION, `no session named '${name}'`, {
        field: 'name',
        correction_hint: 'open it first or use one of the listed sessions',
        valid_values: [...sessions.keys()],
      });
    }
    return s;
  }

  /** Chain onto the session's per-session promise so its commands run strictly in order. */
  function runQueued(s, fn) {
    s.lastTouch = Date.now();
    const run = s.queue.then(async () => {
      s.busy = true;
      try {
        return await fn();
      } finally {
        s.busy = false;
        s.lastTouch = Date.now();
      }
    });
    s.queue = run.catch(() => {}); // keep the chain alive across a failed command
    return run;
  }

  async function create(name, opts = {}) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw gbErr(CODES.BAD_REQUEST, `invalid session name '${name}'`, {
        field: 'name',
        correction_hint: 'use 1-64 chars of [A-Za-z0-9._-]',
      });
    }
    if (sessions.has(name)) {
      throw gbErr(CODES.DUP_SESSION, `session '${name}' already exists`, {
        field: 'name',
        correction_hint: 'destroy it first or pick another name',
        valid_values: [...sessions.keys()],
      });
    }
    const rec = {
      name,
      createdAt: Date.now(),
      lastTouch: Date.now(),
      headed: !!opts.headed,
      seq: 0,
      busy: false,
      queue: Promise.resolve(),
      context: null,
    };
    sessions.set(name, rec); // reserve the name synchronously (no await gap = no dup race)
    try {
      const browser = await ensureBrowser(rec.headed);
      const ctxOpts = {};
      if (opts.viewport) ctxOpts.viewport = opts.viewport;
      if (opts.colorScheme) ctxOpts.colorScheme = opts.colorScheme;
      if (opts.baseUrl) ctxOpts.baseURL = opts.baseUrl;
      rec.context = await browser.newContext(ctxOpts);
      rec.page = await rec.context.newPage();
      rec.cdp = await rec.context.newCDPSession(rec.page);
      rec.journal = createJournal(PATHS.sessions, name);
      rec.journal.log('create', {
        headed: rec.headed,
        viewport: opts.viewport ?? null,
        colorScheme: opts.colorScheme ?? null,
      });
      return info(name);
    } catch (e) {
      sessions.delete(name); // failed setup must not leave a half-session holding the name
      throw e;
    }
  }

  function info(name) {
    const s = get(name);
    return {
      name: s.name,
      createdAt: s.createdAt,
      url: s.page.url(),
      headed: s.headed,
      idleMs: Date.now() - s.lastTouch,
    };
  }

  function list() {
    const now = Date.now();
    return [...sessions.values()]
      .filter((s) => s.context)
      .map((s) => ({
        name: s.name,
        createdAt: s.createdAt,
        url: s.page.url(),
        headed: s.headed,
        idleMs: now - s.lastTouch,
      }));
  }

  /**
   * Per-session functional probe, run through the serial queue. Doubles as the queue-ordering
   * proof: `before` is read, a real CDP round-trip awaits, then the counter is bumped — under
   * true serialization N concurrent calls return the permutation 0..N-1 and seq lands at N.
   */
  async function probe(name) {
    const s = get(name);
    return runQueued(s, async () => {
      const before = s.seq;
      const v = await s.cdp.send('Browser.getVersion');
      s.seq = before + 1;
      s.journal.log('command', { op: 'probe', seq: before });
      return { seq: before, product: v.product, jsVersion: v.jsVersion };
    });
  }

  async function destroy(name) {
    const s = get(name);
    sessions.delete(name);
    s.journal.log('destroy', {});
    try {
      await s.context.close(); // closes the context; artifacts on disk are kept
    } catch {
      /* already gone */
    }
    return { name };
  }

  /** Timer-driven idle GC — destroy sessions idle past the TTL, journaling the event. */
  function gcTick() {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (s.context && !s.busy && now - s.lastTouch > idleTtlMs) {
        sessions.delete(s.name);
        s.journal.log('gc', { idleMs: now - s.lastTouch });
        s.context.close().catch(() => {});
      }
    }
  }

  /** Depth probe for the daemon's /probe route — genuine round-trip to shared Chromium. */
  async function browserProbe() {
    const browser = await ensureBrowser(false);
    try {
      const cdp = await browser.newBrowserCDPSession();
      const v = await cdp.send('Browser.getVersion');
      await cdp.detach();
      return { browserVersion: v.product };
    } catch {
      return { browserVersion: browser.version() };
    }
  }

  async function shutdown() {
    for (const s of sessions.values()) s.journal?.log('destroy', { reason: 'shutdown' });
    sessions.clear();
    for (const key of ['headless', 'headed']) {
      const ctx = persistent[key];
      if (ctx) {
        try {
          await Promise.race([ctx.close(), delay(5000)]);
        } catch {
          /* Playwright's win32 taskkill /T /F is the backstop */
        }
      }
    }
  }

  return {
    create,
    list,
    info,
    destroy,
    probe,
    gcTick,
    browserProbe,
    shutdown,
    count: () => sessions.size,
    browserLaunched: () => !!(persistent.headless || persistent.headed),
  };
}
