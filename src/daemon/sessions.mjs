// SessionManager: named BrowserContexts in one shared Chromium (arch §1/§2). Sessions are
// created lazily against a persistent-context browser whose --user-data-dir lives under
// %LOCALAPPDATA%\glassbox\chrome-data\ (so the reaper can find strays). Headless is the
// shared default; a second headed browser is launched on demand. Every session owns a
// context + page + CDP session + artifact dir, and a SERIAL command queue so commands
// within a session never interleave while different sessions run fully parallel.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { PATHS, CODES, ANON_CLIENT, gbErr } from '../protocol.mjs';
import { launchOptions, ensureDisplay, defaultHeaded, describePlatform, IS_SANDBOX } from '../platform.mjs';
import { createJournal } from './journal.mjs';
import { createConsoleBuffer, createNetworkTracker } from './buffers.mjs';
import { installStubs, recordOptions, fontState } from './stubs.mjs';

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

// How long a session counts as "in use by someone else" after its last command. Long enough that a
// colleague's paused investigation is protected, short enough that yesterday's leftovers never
// block a clean slate. Overridable so the behaviour is testable without waiting five minutes.
export const ACTIVE_WINDOW_MS = Number(process.env.GLASSBOX_ACTIVE_WINDOW_MS) || 5 * 60 * 1000;

export function createSessionManager({ idleTtlMs = 30 * 60 * 1000, startTime = Date.now() } = {}) {
  /** name -> session record */
  const sessions = new Map();
  // Persistent contexts keyed by mode; each .browser() is the shared handle we spawn sessions on.
  const persistent = { headless: null, headed: null };
  const launching = { headless: null, headed: null };
  const cdpEndpoint = { headless: null, headed: null }; // {port, browserWs} per mode, or null
  let displayInfo = { display: 'headless' }; // what ensureDisplay actually gave us, for conditions

  async function ensureBrowser(headed) {
    const key = headed ? 'headed' : 'headless';
    if (persistent[key]) return persistent[key].browser();
    if (!launching[key]) {
      const udd = path.join(PATHS.chromeData, key);
      fs.mkdirSync(udd, { recursive: true });
      // Launch options come from the platform seam and NOWHERE else (platform.mjs §2). On Windows
      // that is still `channel:'chromium'`; in a container it resolves a Chromium by path, because
      // playwright pins a browser revision per release and an image shipping a different one makes
      // channel-resolution fail with "run playwright install" — which a package-registry-only
      // egress allowlist cannot do.
      displayInfo = ensureDisplay(headed);
      const launchOpts = launchOptions({ headed: displayInfo.display !== 'headless' });
      launching[key] = chromium
        .launchPersistentContext(udd, launchOpts)
        .then(async (ctx) => {
          persistent[key] = ctx;
          // Drop the default about:blank tab — but NEVER the last one in headed mode. A headed
          // Chromium exits when its final window closes, and a persistent context's default page
          // IS that window: closing it takes the whole browser with it, and the next newContext
          // fails with "Target page, context or browser has been closed". Headless has no window
          // to lose, which is why this never showed up until headed became the sandbox default.
          const pages = ctx.pages();
          const keepOne = headed;
          for (const p of pages.slice(keepOne ? 1 : 0)) p.close().catch(() => {});
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

  /** Who this daemon is — stamped onto NO_SESSION so "the daemon churned under me" is one call. */
  const identity = () => ({ pid: process.pid, startedAt: startTime });

  function get(name) {
    const s = sessions.get(name);
    if (!s || !s.context) {
      throw gbErr(CODES.NO_SESSION, `no session named '${name}'`, {
        field: 'name',
        correction_hint: 'open it first, or use one of the listed sessions — and read the daemon line: a different pid than the one your session opened against means the daemon restarted and took every session with it',
        valid_values: [...sessions.keys()],
        daemon: identity(),
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
      // WHOSE session this is. One machine-wide daemon serves every agent, so without this a
      // destroy verb cannot tell "clean up after me" from "take down everyone else too" (D12).
      client: String(opts.client || ANON_CLIENT).slice(0, 64),
      // Headed is the SANDBOX default and headless the local one — deliberately inverted from
      // every other container browser setup. Measured on an agent container image: headless
      // Chromium reports a 0px scrollbar (overlay scrollbars), headed-under-Xvfb reports the same
      // 15px reserved gutter Windows Chrome does. A 0px scrollbar silently hides the whole
      // `100vw`-overflow and right-edge-clipping bug class, which is precisely what the layout
      // audit exists to catch. `--headless` (or GLASSBOX_HEADLESS=1) opts back out.
      headed: opts.headless ? false : (opts.headed === undefined ? defaultHeaded() : !!opts.headed),
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
      // A container inherits UTC and an unset locale; a page that formats a date or a number then
      // renders differently here than on the developer's machine for reasons that have nothing to
      // do with their code. Pin both so the difference is a stated condition, not a surprise.
      if (IS_SANDBOX) {
        ctxOpts.timezoneId = opts.timezone || process.env.GLASSBOX_TZ || 'America/Los_Angeles';
        ctxOpts.locale = opts.locale || process.env.GLASSBOX_LOCALE || 'en-US';
      } else {
        if (opts.timezone) ctxOpts.timezoneId = opts.timezone;
        if (opts.locale) ctxOpts.locale = opts.locale;
      }
      Object.assign(ctxOpts, recordOptions(opts) || {});
      rec.context = await browser.newContext(ctxOpts);
      // Routes must be installed on the CONTEXT, before any navigation: it is the only hook that
      // survives newPage, popups and navigations (a page-scoped CDP session dies with the tab).
      rec.stubs = await installStubs(rec.context, opts);
      rec.recordHar = opts.recordHar ? String(opts.recordHar) : null;
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
      rec.baseUrl = opts.baseUrl || null;
      rec._tz = ctxOpts.timezoneId || null;
      // Bound accessors so verify (which only ever holds a session record, never the manager) can
      // ask what conditions it is measuring under and which origins are exempt from egress demotion.
      rec.conditionsFn = (extra) => conditions(rec, extra);
      rec.egressCtxFn = () => egressCtx(rec);
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
        client: rec.client,
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
      client: s.client,
      url: s.page.url(),
      headed: s.headed,
      viewport: s.page.viewportSize(),
      idleMs: Date.now() - s.lastTouch,
      daemon: identity(),
      cdp: cdpBlock(s), // browser/target ws + DevTools link (null if no debug port)
      conditions: conditions(s),
    };
  }

  /**
   * The conditions a measurement was taken under. Every verify report carries this, because a
   * finding without its conditions is a claim the instrument cannot support: "0 errors" measured
   * with no fonts, no network and a software rasterizer is a different sentence from "0 errors" on
   * the developer's machine, and only one of them is about their code.
   */
  function conditions(s, { fontEvidence = 0 } = {}) {
    const plat = describePlatform();
    const jailed = plat.egress === 'jailed';
    return {
      platform: plat.kind,
      detectedBy: plat.detectedBy,
      display: s?.headed ? displayInfo.display : 'headless',
      browser: plat.browserPath,
      raster: plat.raster,
      egress: plat.egress,
      fonts: fontState({ jailed, stubs: s?.stubs, evidence: fontEvidence }),
      stubs: s?.stubs || null,
      recordingHar: s?.recordHar || null,
      viewport: s ? s.page.viewportSize() : null,
      colorScheme: s?.colorScheme || 'light',
      timezone: IS_SANDBOX ? (s?._tz || 'America/Los_Angeles') : 'system',
      humanChannel: plat.humanChannel,
    };
  }

  /** The app's own origins — never demoted to "the sandbox blocked it" (see egress.mjs). */
  function appOrigins(s) {
    const out = new Set();
    for (const u of [s.page.url(), s.baseUrl]) {
      if (!u) continue;
      try { const p = new URL(u); out.add(`${p.protocol}//${p.host}`); } catch { /* about:blank */ }
    }
    return [...out];
  }

  /** The context an egress classification needs: policy + the origins that are exempt from it. */
  function egressCtx(s) {
    return { policy: describePlatform().egress === 'jailed' ? 'jailed' : 'open', origins: appOrigins(s) };
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
        client: s.client,
        url: s.page.url(),
        headed: s.headed,
        idleMs: now - s.lastTouch,
      }));
  }

  /**
   * Sessions owned by someone OTHER than `client` that are still in use (created or commanded
   * within the window). This is what stands between a routine "clean slate" and fifteen minutes
   * of another agent's work (D12).
   */
  function foreignActive(client, windowMs = ACTIVE_WINDOW_MS) {
    const now = Date.now();
    const out = new Map();
    for (const s of sessions.values()) {
      if (!s.context || s.client === client) continue;
      const lastUse = Math.max(s.createdAt || 0, s.lastTouch || 0);
      if (now - lastUse > windowMs) continue; // stale leftovers never block a clean slate
      const g = out.get(s.client) || { client: s.client, count: 0, sessions: [], idleMs: Infinity };
      g.count += 1;
      if (g.sessions.length < 8) g.sessions.push(s.name);
      g.idleMs = Math.min(g.idleMs, now - lastUse);
      out.set(s.client, g);
    }
    return [...out.values()];
  }

  /** Destroy exactly the sessions owned by `client`. Returns the names destroyed. */
  async function destroyMine(client) {
    const mine = [...sessions.values()].filter((s) => s.context && s.client === client).map((s) => s.name);
    for (const name of mine) {
      try { await destroy(name); } catch { /* raced with a GC or another destroy */ }
    }
    return mine;
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
    conditions,
    egressCtx,
    cdpInfo,
    destroy,
    destroyMine,
    foreignActive,
    identity,
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
