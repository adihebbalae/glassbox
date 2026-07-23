// Per-session ring buffers, attached once at session create. M2 shipped the console/pageerror
// ring (for action deltas) and the network in-flight tracker (for settle's low-water phase).
// M3 closes two known gaps IN THIS FILE rather than by attaching a second listener set:
//   - error capture at browserContext scope (page-scoped `pageerror` misses popups; see below),
//   - full network taxonomy (failed|httpError|mixedContent|hanging) folded into the SAME
//     requestId bookkeeping settle already relies on.
// No playwright import here: callers pass page/cdp.

// Best-effort "top meaningful stack frame" for the compact `loc` field (full stack kept too).
function stackTop(err) {
  const s = err && err.stack ? String(err.stack) : '';
  const line = s.split('\n').find((l) => /:\d+:\d+/.test(l));
  if (!line) return undefined;
  const m = line.match(/\(?((?:https?:\/\/|file:\/\/|[\w./-]+)[^\s()]*:\d+:\d+)\)?/);
  return m ? m[1] : line.trim().slice(0, 200);
}

/**
 * Console + error ring. Entries: {id, ts, kind: log|warn|error|pageerror, text, loc?, stack?}.
 * `id` is a monotonically-increasing cursor: an action marks it at start, then reads every
 * entry with a larger id as its own console delta. Capped so a render-loop can't flood memory.
 *
 * Errors are captured at **browserContext** scope via `weberror` — a context-wide superset of
 * `page.on('pageerror')` that also survives popups/new tabs a session opens (research 05 §1) —
 * so we do NOT separately subscribe `page.on('pageerror')` (that would double-count). Worker
 * threads get their own console listener since their exceptions never reach the page channel.
 */
export function createConsoleBuffer(page, cap = 500) {
  const buf = [];
  let id = 0;
  const push = (kind, text, loc, stack) => {
    const e = { id: ++id, ts: Date.now(), kind, text: String(text ?? '').slice(0, 2000) };
    if (loc) e.loc = loc;
    if (stack) e.stack = String(stack).slice(0, 4000);
    buf.push(e);
    if (buf.length > cap) buf.shift();
    return e;
  };

  const onConsole = (m) => {
    const t = m.type();
    const kind = t === 'error' ? 'error' : t === 'warning' ? 'warn' : 'log';
    let loc;
    try {
      const l = m.location();
      if (l && l.url) loc = `${l.url}:${l.lineNumber ?? 0}:${l.columnNumber ?? 0}`;
    } catch { /* no location */ }
    push(kind, m.text(), loc);
  };
  page.on('console', onConsole);

  const ctx = page.context();
  ctx.on('weberror', (we) => {
    let err;
    try { err = we.error?.(); } catch { /* older shape */ }
    err = err || we;
    push('pageerror', (err && err.message) || String(err), stackTop(err), err && err.stack);
  });

  // Worker-thread console (and, on newer Playwright, worker errors) — page-level listeners miss it.
  page.on('worker', (w) => {
    try { w.on('console', onConsole); } catch { /* event set varies by version */ }
  });

  return {
    mark: () => id,
    /** Entries newer than `m`, most-recent `limit`, stripped to the compact action-delta shape. */
    since: (m, limit = 10) =>
      buf.filter((e) => e.id > m).slice(-limit).map((e) => ({ kind: e.kind, text: e.text, ...(e.loc ? { loc: e.loc } : {}) })),
    /** Full entries (with stack) newer than `m`, oldest-first, for read()/verify() pagination. */
    entries: (m = 0, kinds = null) =>
      buf.filter((e) => e.id > m && (!kinds || kinds.has(e.kind))),
    all: () => buf.slice(),
  };
}

const SKIP_TYPES = new Set(['WebSocket', 'EventSource']);

/**
 * Network tracker: settle's in-flight low-water counter AND the M3 failure taxonomy, sharing one
 * set of Network.* listeners (do not attach a second set elsewhere). Per-request records are kept
 * in a capped map keyed by requestId (redirects re-fire requestWillBeSent under the same id, so
 * keying by id both avoids double-counting in-flight and lets classify() see the final URL/status).
 *
 * classify() buckets into: `failed` (loadingFailed w/ errorText — CORS/DNS/TLS/refused, excluding
 * caller-canceled), `httpError` (responseReceived 4xx/5xx — these NEVER fire loadingFailed),
 * `hanging` (still in-flight past `hangMs`), `mixedContent` (from console "Mixed Content" strings
 * the caller passes in — the signal is a console warning as often as a network event, research 05).
 */
export function createNetworkTracker(cdp, opts = {}) {
  const inflight = new Set();
  const byId = new Map(); // requestId -> record
  const recCap = opts.recCap || 600;
  const defaultHangMs = opts.hangMs || Number(process.env.GLASSBOX_HANG_MS) || 10000;

  const rec = (id) => {
    let r = byId.get(id);
    if (!r) {
      r = { id, startTs: Date.now() };
      byId.set(id, r);
      if (byId.size > recCap) byId.delete(byId.keys().next().value); // evict oldest
    }
    return r;
  };

  cdp.on('Network.requestWillBeSent', (p) => {
    if (SKIP_TYPES.has(p.type)) return;
    inflight.add(p.requestId);
    const r = rec(p.requestId);
    r.url = p.request?.url || r.url;
    r.method = p.request?.method || r.method;
    if (p.type) r.type = p.type;
    r.sentTs = Date.now();
  });
  cdp.on('Network.responseReceived', (p) => {
    const r = byId.get(p.requestId);
    if (!r) return;
    r.status = p.response?.status;
    r.statusText = p.response?.statusText;
    if (p.type) r.type = p.type;
  });
  const finish = (p, failed) => {
    inflight.delete(p.requestId);
    const r = byId.get(p.requestId);
    if (!r) return;
    r.doneTs = Date.now();
    if (failed) { r.failed = true; r.errorText = p.errorText; r.canceled = !!p.canceled; }
  };
  cdp.on('Network.loadingFinished', (p) => finish(p, false));
  cdp.on('Network.loadingFailed', (p) => finish(p, true));

  const short = (r) => ({ url: r.url, type: r.type, method: r.method, status: r.status });

  return {
    inFlight: () => inflight.size,
    _ids: inflight, // settle + hanging detection share this live Set

    /**
     * Full taxonomy snapshot. `consoleTexts` feeds mixed-content detection (see class doc);
     * `sinceTs` scopes to requests started on/after a timestamp (verify passes the nav time so a
     * prior page's failures don't leak into the current report).
     */
    classify({ consoleTexts = [], hangMs = defaultHangMs, now = Date.now(), sinceTs = 0 } = {}) {
      const failed = [], httpError = [], hanging = [];
      for (const r of byId.values()) {
        if (sinceTs && r.startTs < sinceTs) continue;
        if (r.failed && !r.canceled && r.errorText) {
          failed.push({ ...short(r), errorText: r.errorText });
        } else if (typeof r.status === 'number' && r.status >= 400) {
          httpError.push(short(r));
        }
        if (inflight.has(r.id) && now - r.startTs > hangMs) {
          hanging.push({ ...short(r), ageMs: now - r.startTs });
        }
      }
      const mixedContent = [];
      for (const t of consoleTexts) if (/Mixed Content/i.test(t)) mixedContent.push(String(t).slice(0, 300));
      return { failed, httpError, hanging, mixedContent };
    },
    /** All recorded requests (for the on-disk netlog artifact). */
    all: () => [...byId.values()].map((r) => ({
      url: r.url, type: r.type, method: r.method, status: r.status,
      failed: !!r.failed, errorText: r.errorText, canceled: !!r.canceled,
      ms: r.doneTs && r.sentTs ? r.doneTs - r.sentTs : undefined,
    })),
  };
}
