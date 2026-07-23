// Per-session ring buffers, attached once at session create. M2 ships the console/pageerror
// ring (for action deltas) and the network in-flight tracker (for settle's low-water phase).
// M3 extends THIS file with the full network taxonomy (failed|httpError|mixedContent|hanging)
// and per-frame/worker error capture — it should reuse createNetworkTracker's requestId
// bookkeeping (the same requestWillBeSent/loadingFinished/loadingFailed wiring) rather than
// attaching a second set of listeners. No playwright import here: callers pass page/cdp.

/**
 * Console + pageerror ring. Entries: {id, ts, kind: log|warn|error|pageerror, text, loc?}.
 * `id` is a monotonically-increasing cursor: an action marks it at start, then reads every
 * entry with a larger id as its own console delta. Capped so a render-loop can't flood memory.
 */
export function createConsoleBuffer(page, cap = 500) {
  const buf = [];
  let id = 0;
  const push = (kind, text, loc) => {
    buf.push({ id: ++id, ts: Date.now(), kind, text: String(text ?? '').slice(0, 2000), loc });
    if (buf.length > cap) buf.shift();
  };
  page.on('console', (m) => {
    const t = m.type();
    const kind = t === 'error' ? 'error' : t === 'warning' ? 'warn' : 'log';
    let loc;
    try {
      const l = m.location();
      if (l && l.url) loc = `${l.url}:${l.lineNumber ?? 0}`;
    } catch { /* no location */ }
    push(kind, m.text(), loc);
  });
  page.on('pageerror', (e) => {
    const stack = e && e.stack ? String(e.stack).split('\n')[1]?.trim() : undefined;
    push('pageerror', (e && e.message) || String(e), stack);
  });
  return {
    mark: () => id,
    /** Entries newer than `m`, most-recent `limit`, stripped to the wire shape. */
    since: (m, limit = 10) =>
      buf.filter((e) => e.id > m).slice(-limit).map((e) => ({ kind: e.kind, text: e.text, ...(e.loc ? { loc: e.loc } : {}) })),
    all: () => buf.slice(),
  };
}

/**
 * Network in-flight tracker for settle's low-water phase. Counts real fetches (documents,
 * scripts, XHR/fetch, images…) and EXCLUDES long-lived push channels (WebSocket, EventSource)
 * that never "finish" and would make settle hang. requestId-keyed Set so redirects (which
 * re-fire requestWillBeSent under the same id) don't double-count.
 */
export function createNetworkTracker(cdp) {
  const inflight = new Set();
  const SKIP = new Set(['WebSocket', 'EventSource']);
  cdp.on('Network.requestWillBeSent', (p) => {
    if (SKIP.has(p.type)) return;
    inflight.add(p.requestId);
  });
  const done = (p) => inflight.delete(p.requestId);
  cdp.on('Network.loadingFinished', done);
  cdp.on('Network.loadingFailed', done);
  return {
    inFlight: () => inflight.size,
    _ids: inflight, // M3: reuse this Set for hanging-request detection
  };
}
