// Composite settle (arch §4). `networkidle` is a deprecated trap; instead we wait, in order and
// each individually bounded by a shared deadline, for: an outstanding navigation/load →
// network low-water (in-flight==0, 250ms debounce, websockets/EventSource excluded) → DOM quiet
// (injected MutationObserver: no mutation for 300ms) → two chained rAFs → the Astro island
// signal (`astro-island[ssr]` absent). Hard cap (default 8s) returns {settled:false, why:[...]}
// rather than hang. This module also OWNS the page-side MutationObserver that observe/actions
// share for staleness + mutation-count deltas.

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// One injected observer, keyed on window globals. It records a dirty flag (ref staleness), a
// cumulative mutation count (action deltas), and a last-mutation timestamp (DOM-quiet gate).
const OBS_BODY = `
window.__gbxDirty=false;window.__gbxMut=0;window.__gbxLastMut=Date.now();
if(window.__gbxObs){try{window.__gbxObs.disconnect();}catch(e){}}
window.__gbxObs=new MutationObserver(function(l){window.__gbxDirty=true;window.__gbxMut+=l.length;window.__gbxLastMut=Date.now();});
try{window.__gbxObs.observe(document.documentElement||document,{subtree:true,childList:true,attributes:true,characterData:true});}catch(e){}`;
const INSTALL_SRC = `(function(){${OBS_BODY};return 'reset';})()`;
const ENSURE_SRC = `(function(){if(window.__gbxObs)return 'exists';${OBS_BODY};return 'installed';})()`;

/** Force a fresh observer + reset counters — observe() calls this so a snapshot is a clean baseline. */
export const installObserver = (page) => page.evaluate(INSTALL_SRC).catch(() => {});
/** Install the observer only if absent (survives across actions; re-arms after a navigation wipes it). */
export const ensureObserver = (session) => session.page.evaluate(ENSURE_SRC).catch(() => {});
/** Cumulative mutation count since the observer was (re)installed. */
export const readMut = (session) => session.page.evaluate('window.__gbxMut||0').catch(() => 0);
/** Has the DOM mutated since the last observe/install? (ref-staleness gate) */
export const isDirty = (session) => session.page.evaluate('!!window.__gbxDirty').catch(() => false);

/** Poll `pred` until it stays true continuously for `stableMs`, or the deadline passes. */
async function stableFor(pred, stableMs, pollMs, deadline) {
  let since = null;
  while (Date.now() < deadline) {
    let ok = false;
    try { ok = await pred(); } catch { ok = false; }
    if (ok) {
      if (since == null) since = Date.now();
      if (Date.now() - since >= stableMs) return true;
    } else since = null;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return false;
}

/** DOM quiet = the injected observer reports no mutation for `quietMs` (absent observer == quiet). */
async function domQuiet(page, quietMs, pollMs, deadline) {
  while (Date.now() < deadline) {
    const quiet = await page
      .evaluate((q) => !window.__gbxObs || Date.now() - (window.__gbxLastMut || 0) > q, quietMs)
      .catch(() => true);
    if (quiet) return true;
    await delay(pollMs);
  }
  return false;
}

/**
 * Run the composite settle. `opts.navigation` (bool) enables the load-wait phase; `opts.capMs`
 * overrides the 8s hard cap. Never throws; returns {settled, why}. `why` names each phase that
 * hit the deadline (['load','network','dom','raf','astro']).
 */
export async function settle(session, opts = {}) {
  const { page, net } = session;
  const cap = opts.capMs ?? (Number(process.env.GLASSBOX_SETTLE_CAP_MS) || 8000);
  const deadline = Date.now() + cap;
  const remaining = () => Math.max(0, deadline - Date.now());
  const why = [];

  await ensureObserver(session); // re-arm after a navigation so the DOM-quiet phase can gate

  if (opts.navigation) {
    try { await page.waitForLoadState('load', { timeout: remaining() }); }
    catch { why.push('load'); }
  }
  if (net && !(await stableFor(() => net.inFlight() === 0, 250, 50, deadline))) why.push('network');
  if (!(await domQuiet(page, 300, 100, deadline))) why.push('dom');
  try {
    await Promise.race([
      page.evaluate('new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(true);});});})'),
      delay(remaining()).then(() => { throw new Error('raf'); }),
    ]);
  } catch { why.push('raf'); }
  if (!(await stableFor(() => page.evaluate("!document.querySelector('astro-island[ssr]')").catch(() => true), 1, 50, deadline)))
    why.push('astro');

  return { settled: why.length === 0, why };
}
