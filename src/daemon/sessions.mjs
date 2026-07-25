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
import { createConsoleBuffer, createNetworkTracker } from './buffers.mjs';

const NAME_RE = /^[\w.-]{1,64}$/;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const DIALOG_TTL_MS = 30 * 1000; // auto-dismiss a stashed dialog so it never wedges a session forever

// Native dialogs are STASHED, not auto-answered: surface them in every response and let the
// caller respond via the dialog action. A 30s watchdog dismisses an ignored one (journaled).
function onDialog(rec, d) {
  rec._dialog = d;
  rec.pendingDialog = { type: d.type(), message: d.message(), defaultValue: d.defaultValue?.() ?? '' };
  rec.journal.log('dialog', { type: rec.pendingDialog.type, message: rec.pendingDialog.message });
  const waiters = rec._dialogWaiters;
  rec._dialogWaiters = [];
  for (const w of waiters) w();
  rec._dialogTimer = setTimeout(async () => {
    if (!rec.pendingDialog) return;
    try { await d.dismiss(); } catch { /* already gone */ }
    rec.journal.log('dialog-autodismiss', { after: DIALOG_TTL_MS });
    rec.pendingDialog = null;
    rec._dialog = null;
    if (rec._inflight) { rec._inflight.catch(() => {}); rec._inflight = null; }
  }, DIALOG_TTL_MS);
  rec._dialogTimer.unref?.();
}

// Chromium drops a DevToolsActivePort file in the --user-data-dir when launched with a
// --remote-debugging-port: line 1 is the actual port, line 2 the browser ws path. We parse it to
// expose a real CDP endpoint for the M6 "paste into DevTools" link (Playwright drives via its own
// pipe; a second TCP port coexists — multi-client CDP, research 02 §14). Best-effort: absent file
// → no DevTools link, screencast (which needs no debug port) still works.
async function readCdpEndpoint(udd) {
  const file = path.join(udd, 'DevToolsActivePort');
  for (let i = 0; i < 20; i++) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const nl = raw.indexOf('\n');
      const port = Number((nl < 0 ? raw : raw.slice(0, nl)).trim());
      const wsPath = nl < 0 ? '' : raw.slice(nl + 1).trim();
      if (port) return { port, browserWs: `ws://127.0.0.1:${port}${wsPath}` };
    } catch { /* not written yet */ }
    await delay(50);
  }
  return null;
}

export function createSessionManager({ idleTtlMs = 30 * 60 * 1000 } = {}) {
  /** name -> session record */
  const sessions = new Map();
  // Persistent contexts keyed by mode; each .browser() is the shared handle we spawn sessions on.
  const persistent = { headless: null, headed: null };
  const launching = { headless: null, headed: null };
  const cdpEndpoint = { headless: null, headed: null }; // {port, browserWs} per mode, or null

  async function ensureBrowser(headed) {
    const key = headed ? 'headed' : 'headless';
    if (persistent[key]) return persistent[key].browser();
    if (!launching[key]) {
      const udd = path.join(PATHS.chromeData, key);
      fs.mkdirSync(udd, { recursive: true });
      launching[key] = chromium
        .launchPersistentContext(udd, { channel: 'chromium', headless: !headed, args: ['--remote-debugging-port=0'] })
        .then(async (ctx) => {
          persistent[key] = ctx;
          for (const p of ctx.pages()) p.close().catch(() => {}); // drop the default about:blank tab
          cdpEndpoint[key] = await readCdpEndpoint(udd); // best-effort; null if the file never appears
          return ctx;
        })
        .catch((err) => {
          launching[key] = null; // don't poison the mode — let the next create retry a transient failure
          throw err;
        });
    }
    return (await launching[key]).browser();
  }

  /** The CDP block for a session's info: browser ws + this page's target ws + a DevTools link, or null. */
  function cdpBlock(s) {
    const ep = cdpEndpoint[s.headed ? 'headed' : 'headless'];
    if (!ep || !s.targetId) return null;
    const targetWs = `ws://127.0.0.1:${ep.port}/devtools/page/${s.targetId}`;
    return {
      browserWs: ep.browserWs,
      targetWs,
      devtoolsFrontend: `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${ep.port}/devtools/page/${s.targetId}`,
    };
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
      // The page target's id is stable for the tab's life (survives navigations) — cache it so the
      // watch/DevTools URLs in info() stay synchronous. Non-fatal if unavailable.
      try { rec.targetId = (await rec.cdp.send('Target.getTargetInfo')).targetInfo?.targetId || null; }
      catch { rec.targetId = null; }
      // M2 per-tab defaults: bypass the service worker + disable cache so a stale build never
      // reports as fresh (research 07). Network.enable also feeds settle's in-flight tracker.
      await rec.cdp.send('Network.enable').catch(() => {});
      await rec.cdp.send('Network.setBypassServiceWorker', { bypass: true }).catch(() => {});
      await rec.cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
      rec.net = createNetworkTracker(rec.cdp);
      rec.console = createConsoleBuffer(rec.page);
      rec.observe = { version: 0, navSeq: 0, navSeqAt: 0, registry: new Map() };
      // M3 theme-sweep plumbing: colorScheme rode into newContext above; themeAttr (e.g.
      // 'data-theme') is the site's own theme mechanism verify drives alongside emulateMedia.
      rec.colorScheme = opts.colorScheme || null;
      rec.themeAttr = opts.themeAttr || null;
      // themeClass is themeAttr's sibling for the OTHER dominant mechanism: Tailwind's
      // darkMode:['class'] — a bare `dark` class on <html>, which no attribute sweep can reach.
      rec.themeClass = opts.themeClass || null;
      // W4: pathnames whose 404 is expected (a dev server's /favicon.ico). verify demotes those
      // rows to an info count — and ONLY when the status really is 404.
      rec.ignore404 = Array.isArray(opts.ignore404) ? opts.ignore404.filter(Boolean).map(String)
        : (typeof opts.ignore404 === 'string' && opts.ignore404 ? opts.ignore404.split(',').filter(Boolean) : []);
      // Nav markers scope verify's error/network report to the CURRENT page load (a prior page's
      // console errors and 4xx must not leak into this page's report).
      rec._navMark = 0;
      rec._navTs = 0;
      // W3 load-state bookkeeping: a report has to be able to say whether it measured a COLD first
      // load or a warm one, because a warm reload silently drops first-load findings (a negatively
      // cached 404 is never re-requested; CLS is a first-paint race a warm load wins). `load` fires
      // once per real DOCUMENT load — a same-document (pushState) navigation fires framenavigated
      // without it, which is exactly the distinction we need.
      rec._nav = { docLoads: 0, byUrl: new Map(), lastLoadUrl: null, sameDoc: false };
      rec.page.on('load', () => {
        try {
          const u = rec.page.url();
          rec._nav.docLoads += 1;
          rec._nav.byUrl.set(u, (rec._nav.byUrl.get(u) || 0) + 1);
          rec._nav.lastLoadUrl = u;
          rec._nav.sameDoc = false;
        } catch { /* torn down */ }
      });
      rec.pendingDialog = null;
      rec._dialog = null;
      rec._inflight = null;
      rec._dialogWaiters = [];
      rec._dialogTimer = null;
      rec.page.on('framenavigated', (f) => {
        try {
          if (f === rec.page.mainFrame()) {
            rec.observe.navSeq += 1;
            rec._navMark = rec.console.mark();
            rec._navTs = Date.now();
            // Provisionally same-document; the `load` that follows a real navigation clears it.
            // (Only meaningful once something has loaded — before that it is just the first nav.)
            if (rec._nav.docLoads > 0 && rec.page.url() !== rec._nav.lastLoadUrl) rec._nav.sameDoc = true;
          }
        } catch { /* torn down */ }
      });
      rec.page.on('dialog', (d) => onDialog(rec, d));
      rec.journal = createJournal(PATHS.sessions, name);
      rec.journal.log('create', {
        headed: rec.headed,
        viewport: opts.viewport ?? null,
        colorScheme: opts.colorScheme ?? null,
        themeAttr: rec.themeAttr,
        themeClass: rec.themeClass,
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
      viewport: s.page.viewportSize(),
      idleMs: Date.now() - s.lastTouch,
      cdp: cdpBlock(s), // browser/target ws + DevTools link (null if no debug port)
    };
  }

  /** Just the CDP endpoint block for a session (used by the watch page's DevTools link). */
  function cdpInfo(name) {
    return cdpBlock(get(name));
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
    clearTimeout(s._dialogTimer); // don't let a stashed-dialog watchdog fire on a closed context
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
    cdpInfo,
    destroy,
    probe,
    gcTick,
    browserProbe,
    shutdown,
    count: () => sessions.size,
    browserLaunched: () => !!(persistent.headless || persistent.headed),
    // Exposed for the M2 action layer (actions.mjs): the session record + the serial queue.
    _get: get,
    runQueued,
  };
}
