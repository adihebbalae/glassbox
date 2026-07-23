// White-box debug plane (arch §6, spike 2 + research 02 §7). Breakpoints resolved through
// Debugger.getPossibleBreakpoints (the spike-2 off-by-one lesson: a breakpoint requested on a
// declaration line pauses BEFORE initialization, so we snap to the first valid location at-or-
// after the requested line); a per-session pause sub-state (`session.debug`) holds the frozen
// call frames so debug commands can inspect/step/resume WITHOUT the page's main thread running.
//
// Queue discipline (the deadlock trap): a paused page's fire-and-forget click is still parked in
// the session's serial queue, so any command that needs the queue would hang behind it. Debug
// control ops therefore run in a PARALLEL lane (bypassing runQueued) — V8's debugger agent and
// the compositor service them while the main thread is frozen (Debugger.*, Runtime.getProperties
// on a scope objectId, Page.captureScreenshot are all spike-proven while paused; NEVER
// Runtime.evaluate while paused — it targets the live global context and hangs, research 02 §7).
// Normal actions against a paused session return a structured PAUSED error (see handleAction),
// never a hang. Ops that DO need the live page (listeners/coverage) go through the queue and are
// refused while paused.
import fs from 'node:fs';
import { CODES, gbErr } from '../protocol.mjs';
import { sourceMapper } from './sourcemaps.mjs';
import { coverageStart, coverageStop } from './coverage.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Ops that must work while the queue is held by a parked (paused) action → parallel lane.
const DIRECT = new Set(['state', 'inspect', 'eval', 'step', 'resume', 'pause', 'screenshot', 'break', 'list', 'remove']);
// Ops that touch the live page main thread → serial queue, refused while paused.
const QUEUED = new Set(['listeners', 'coverage-start', 'coverage-stop']);

/** Compact a URL to its path (+ last query key stripped) for readable file:line output. */
function shortUrl(url) {
  if (!url) return '';
  try { return new URL(url).pathname || url; } catch { return String(url).slice(0, 120); }
}

/** Lazily attach the per-session debug sub-state. Kept off the record until debug is first used. */
function ensureDebugState(s) {
  if (!s.debug) {
    s.debug = {
      enabled: false, paused: false, rawPause: null,
      scripts: [], breakpoints: new Map(), coverage: null,
      pauseWaiters: [], resumeWaiters: [],
    };
  }
  return s.debug;
}

function onPaused(s, ev) {
  const dbg = s.debug;
  dbg.paused = true;
  dbg.rawPause = ev;
  s.journal.log('debug', { event: 'paused', reason: ev.reason, hit: ev.hitBreakpoints || [] });
  const w = dbg.pauseWaiters; dbg.pauseWaiters = [];
  for (const r of w) r(ev);
}
function onResumed(s) {
  const dbg = s.debug;
  dbg.paused = false; dbg.rawPause = null;
  const w = dbg.resumeWaiters; dbg.resumeWaiters = [];
  for (const r of w) r(true);
}

/** Enable the Debugger domain once, wiring script + pause listeners. Re-emits scriptParsed for
 *  scripts parsed before enable (standard CDP), so a breakpoint on an already-loaded file works. */
async function ensureDebugger(s) {
  const dbg = ensureDebugState(s);
  if (dbg.enabled) return dbg;
  const { cdp } = s;
  cdp.on('Debugger.scriptParsed', (p) => {
    dbg.scripts.push({ scriptId: p.scriptId, url: p.url || '', sourceMapURL: p.sourceMapURL || '', endLine: p.endLine });
  });
  cdp.on('Debugger.paused', (ev) => onPaused(s, ev));
  cdp.on('Debugger.resumed', () => onResumed(s));
  await cdp.send('Debugger.enable').catch(() => {});
  await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' }).catch(() => {});
  dbg.enabled = true;
  return dbg;
}

// ---- waiters ---------------------------------------------------------------

function waitForNextPause(dbg, ms) {
  return new Promise((resolve) => {
    const res = (ev) => { clearTimeout(t); resolve(ev); };
    const t = setTimeout(() => {
      const i = dbg.pauseWaiters.indexOf(res); if (i >= 0) dbg.pauseWaiters.splice(i, 1);
      resolve(null);
    }, ms);
    dbg.pauseWaiters.push(res);
  });
}
function waitForResumed(dbg, ms) {
  return new Promise((resolve) => {
    const res = () => { clearTimeout(t); resolve(true); };
    const t = setTimeout(() => {
      const i = dbg.resumeWaiters.indexOf(res); if (i >= 0) dbg.resumeWaiters.splice(i, 1);
      resolve(false);
    }, ms);
    dbg.resumeWaiters.push(res);
  });
}

// ---- breakpoints -----------------------------------------------------------

function findScript(dbg, suffix) {
  for (let i = dbg.scripts.length - 1; i >= 0; i--) {
    const sc = dbg.scripts[i];
    if (!sc.url) continue;
    const path = sc.url.split('?')[0].split('#')[0];
    if (path.endsWith(suffix) || path.endsWith('/' + suffix) || path === suffix) return sc;
  }
  // looser contains match, still most-recent-first
  for (let i = dbg.scripts.length - 1; i >= 0; i--) {
    const sc = dbg.scripts[i];
    if (sc.url && sc.url.includes(suffix)) return sc;
  }
  return null;
}
async function waitForScript(dbg, suffix, ms) {
  const dl = Date.now() + ms;
  let sc = findScript(dbg, suffix);
  while (!sc && Date.now() < dl) { await delay(50); sc = findScript(dbg, suffix); }
  return sc;
}

async function setBreak(s, body) {
  const dbg = await ensureDebugger(s);
  const { cdp } = s;
  const condition = body.condition || undefined;

  // urlRegex form — no scriptId to resolve against, so we let Chrome snap to a valid location.
  if (body.urlRegex && !body.file) {
    const line0 = (body.line || 1) - 1;
    const bp = await cdp.send('Debugger.setBreakpointByUrl', { urlRegex: body.urlRegex, lineNumber: line0, columnNumber: 0, condition });
    const loc = bp.locations && bp.locations[0];
    const line = (loc ? loc.lineNumber : line0) + 1;
    dbg.breakpoints.set(bp.breakpointId, { urlRegex: body.urlRegex, line, condition: condition || null });
    s.journal.log('debug', { event: 'break', urlRegex: body.urlRegex, line, bp: bp.breakpointId });
    return { ok: true, breakpointId: bp.breakpointId, urlRegex: body.urlRegex, line, resolved: !!loc };
  }

  if (!body.file) throw gbErr(CODES.BAD_REQUEST, 'break needs `file` (URL suffix) or `urlRegex`', { field: 'file', correction_hint: "e.g. file:'app.js', line:42" });
  const requested = body.line || 1;
  const line0 = requested - 1;
  const script = await waitForScript(dbg, body.file, 1500);
  if (!script) {
    throw gbErr(CODES.BAD_REQUEST, `no loaded script matches '${body.file}'`, {
      field: 'file', correction_hint: 'goto the page first, then break; use a URL suffix like app.js',
      valid_values: dbg.scripts.map((sc) => shortUrl(sc.url)).filter(Boolean).slice(0, 20),
    });
  }

  // Resolve to the first valid location AT OR AFTER the requested line (spike-2 off-by-one fix).
  let resolved = null;
  try {
    const endLine = script.endLine != null ? Math.min(line0 + 200, script.endLine) : line0 + 200;
    const { locations } = await cdp.send('Debugger.getPossibleBreakpoints', {
      start: { scriptId: script.scriptId, lineNumber: line0, columnNumber: 0 },
      end: { scriptId: script.scriptId, lineNumber: endLine },
      restrictToFunction: false,
    });
    const sorted = (locations || []).slice().sort((a, b) => (a.lineNumber - b.lineNumber) || ((a.columnNumber || 0) - (b.columnNumber || 0)));
    resolved = sorted.find((l) => l.lineNumber >= line0) || sorted[0] || null;
  } catch { /* fall back to the raw line below */ }

  const bp = await cdp.send('Debugger.setBreakpointByUrl', {
    url: script.url,
    lineNumber: resolved ? resolved.lineNumber : line0,
    columnNumber: resolved ? resolved.columnNumber : 0,
    condition,
  });
  const finalLoc = bp.locations && bp.locations[0];
  const line = ((finalLoc ? finalLoc.lineNumber : (resolved ? resolved.lineNumber : line0))) + 1;
  const file = shortUrl(script.url);
  dbg.breakpoints.set(bp.breakpointId, { file, url: script.url, line, requested, condition: condition || null });
  s.journal.log('debug', { event: 'break', file, line, requested, bp: bp.breakpointId });
  return { ok: true, breakpointId: bp.breakpointId, file, url: script.url, line, requested };
}

function listBreaks(s) {
  const dbg = ensureDebugState(s);
  return { ok: true, breakpoints: [...dbg.breakpoints.entries()].map(([id, r]) => ({ breakpointId: id, ...r })) };
}
async function removeBreak(s, body) {
  const dbg = ensureDebugState(s);
  const ids = body.all ? [...dbg.breakpoints.keys()] : [body.breakpointId].filter(Boolean);
  if (!ids.length) throw gbErr(CODES.BAD_REQUEST, 'remove needs `breakpointId` or `all:true`', { field: 'breakpointId' });
  for (const id of ids) {
    await s.cdp.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(() => {});
    dbg.breakpoints.delete(id);
  }
  s.journal.log('debug', { event: 'remove', ids });
  return { ok: true, removed: ids };
}

// ---- pause introspection ---------------------------------------------------

const notPaused = () => gbErr(CODES.BAD_REQUEST, 'session is not paused', { field: 'op', correction_hint: 'set a breakpoint and trigger it first' });
const badFrame = (i) => gbErr(CODES.BAD_REQUEST, `no call frame at index ${i}`, { field: 'frame' });

function previewOf(v) {
  if (!v) return 'undefined';
  if ('value' in v) { try { return JSON.stringify(v.value).slice(0, 120); } catch { return String(v.value).slice(0, 120); } }
  if (v.description) return String(v.description).slice(0, 120);
  if (v.unserializableValue) return String(v.unserializableValue).slice(0, 120);
  return String(v.type).slice(0, 120);
}

/** Build the distilled paused state: call frames with source-mapped locations. */
async function buildState(s) {
  const dbg = ensureDebugState(s);
  if (!dbg.paused || !dbg.rawPause) return { paused: false };
  const mapper = sourceMapper(s);
  const raw = dbg.rawPause.callFrames || [];
  const frames = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    const loc = f.location || {};
    const script = dbg.scripts.find((sc) => sc.scriptId === loc.scriptId);
    const url = script ? script.url : (f.url || '');
    const line = (loc.lineNumber || 0) + 1;
    const column = (loc.columnNumber || 0) + 1;
    // page-free: fetching a map now would hang the frozen main thread (research 02 §7)
    const orig = url ? mapper.remapLocCached(`${url}:${line}:${column}`) : null;
    frames.push({ index: i, functionName: f.functionName || '(anonymous)', file: shortUrl(url), url, line, column, ...(orig ? { orig } : {}) });
  }
  return { paused: true, reason: dbg.rawPause.reason, hitBreakpoints: dbg.rawPause.hitBreakpoints || [], frames };
}

async function inspect(s, body) {
  const dbg = ensureDebugState(s);
  if (!dbg.paused || !dbg.rawPause) throw notPaused();
  const idx = body.frame > 0 ? body.frame : 0;
  const frame = dbg.rawPause.callFrames[idx];
  if (!frame) throw badFrame(idx);
  const scopes = [];
  for (const sc of frame.scopeChain || []) {
    const scope = { type: sc.type, ...(sc.name ? { name: sc.name } : {}), vars: [] };
    const oid = sc.object && sc.object.objectId;
    // Skip the global scope — its thousands of props are noise (DevTools collapses it too); the
    // actionable variables live in local/closure/block/catch/with scopes.
    if (oid && sc.type !== 'global') {
      try {
        // getProperties on a scope objectId is serviced while paused; NEVER Runtime.evaluate here.
        const { result } = await s.cdp.send('Runtime.getProperties', { objectId: oid, ownProperties: true, generatePreview: false });
        scope.vars = (result || []).slice(0, 30).map((p) => ({ name: p.name, type: (p.value && p.value.type) || 'undefined', value: previewOf(p.value) }));
      } catch { /* scope object gone */ }
    }
    scopes.push(scope);
  }
  return { ok: true, frame: idx, functionName: frame.functionName || '(anonymous)', scopes };
}

async function evalFrame(s, body) {
  const dbg = ensureDebugState(s);
  if (!dbg.paused || !dbg.rawPause) throw notPaused();
  const idx = body.frame > 0 ? body.frame : 0;
  const frame = dbg.rawPause.callFrames[idx];
  if (!frame) throw badFrame(idx);
  const expression = String(body.expression || '');
  if (!expression) throw gbErr(CODES.BAD_REQUEST, 'eval needs an expression', { field: 'expression' });
  let r;
  try {
    r = await s.cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, returnByValue: true, generatePreview: true, throwOnSideEffect: false });
  } catch {
    r = await s.cdp.send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, returnByValue: false, generatePreview: true });
  }
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception;
    return { ok: true, threw: true, error: (ex && ex.description) || r.exceptionDetails.text };
  }
  const v = r.result || {};
  if ('value' in v) return { ok: true, type: v.type, value: v.value };
  return { ok: true, type: v.type, preview: previewOf(v) };
}

async function step(s, body) {
  const dbg = ensureDebugState(s);
  if (!dbg.paused) throw notPaused();
  const mode = body.mode || 'over';
  const method = { over: 'Debugger.stepOver', into: 'Debugger.stepInto', out: 'Debugger.stepOut' }[mode];
  if (!method) throw gbErr(CODES.BAD_REQUEST, `unknown step mode '${mode}'`, { field: 'mode', valid_values: ['over', 'into', 'out'] });
  const next = waitForNextPause(dbg, 4000); // a step always emits resumed then paused; wait for the landing
  await s.cdp.send(method).catch(() => {});
  const ev = await next;
  if (!ev) return { ok: true, paused: false, resumed: true }; // stepped off the end — execution completed
  return { ok: true, ...(await buildState(s)) };
}

async function resume(s) {
  const dbg = ensureDebugState(s);
  if (!dbg.paused) return { ok: true, paused: false, note: 'not paused' };
  const done = waitForResumed(dbg, 4000);
  await s.cdp.send('Debugger.resume').catch(() => {});
  await done;
  s.journal.log('debug', { event: 'resume' });
  return { ok: true, resumed: true };
}

async function pause(s) {
  await ensureDebugger(s);
  await s.cdp.send('Debugger.pause').catch(() => {});
  return { ok: true, requested: true }; // pauses on the next JS statement (runaway-loop escape hatch)
}

async function screenshot(s) {
  await s.cdp.send('Page.enable').catch(() => {}); // guarded/idempotent per M3 handoff
  const { data } = await s.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = s.journal.alloc('shots', `debug-${Date.now()}.png`);
  fs.writeFileSync(path, Buffer.from(data, 'base64'));
  s.journal.log('debug', { event: 'screenshot', path });
  return { ok: true, path, bytes: Math.round(data.length * 0.75) };
}

// ---- event listeners (dead-button discovery) -------------------------------

async function resolveObjectId(s, body) {
  const { cdp } = s;
  if (body.ref) {
    const reg = s.observe && s.observe.registry.get(body.ref);
    if (!reg) throw gbErr(CODES.STALE_REF, `ref '${body.ref}' is unknown`, { field: 'ref', correction_hint: 'observe first' });
    await cdp.send('DOM.enable').catch(() => {});
    const r = await cdp.send('DOM.resolveNode', { backendNodeId: reg.backendNodeId }).catch(() => null);
    const oid = r && r.object && r.object.objectId;
    if (!oid) throw gbErr(CODES.STALE_REF, `ref '${body.ref}' no longer resolves`, { field: 'ref', correction_hint: 're-observe' });
    return oid;
  }
  const selector = body.selector;
  if (!selector) throw gbErr(CODES.NO_TARGET, 'listeners needs `selector` or `ref`', { field: 'selector' });
  const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false });
  if (!result || !result.objectId) throw gbErr(CODES.NO_TARGET, `selector '${selector}' matched nothing`, { field: 'selector', correction_hint: 'check the selector' });
  return result.objectId;
}

async function listeners(s, body) {
  await ensureDebugger(s); // scriptParsed map lets us name each handler's source file
  const { cdp } = s;
  const objectId = await resolveObjectId(s, body);
  const mapper = sourceMapper(s);
  let raw = [];
  try { raw = (await cdp.send('DOMDebugger.getEventListeners', { objectId, depth: 1 })).listeners || []; }
  finally { cdp.send('Runtime.releaseObject', { objectId }).catch(() => {}); }
  const out = [];
  for (const L of raw) {
    const script = s.debug.scripts.find((sc) => sc.scriptId === L.scriptId);
    const url = script ? script.url : '';
    const line = (L.lineNumber || 0) + 1;
    let sourceLoc = url ? `${shortUrl(url)}:${line}` : null;
    if (url) { const orig = await mapper.remapLoc(`${url}:${line}:${(L.columnNumber || 0) + 1}`).catch(() => null); if (orig) sourceLoc = `${orig.file}:${orig.line}`; }
    let source = '';
    const hid = L.handler && L.handler.objectId;
    if (hid) {
      try {
        const r = await cdp.send('Runtime.callFunctionOn', { objectId: hid, functionDeclaration: 'function(){return this.toString()}', returnByValue: true });
        source = String((r.result && r.result.value) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      } catch { /* handler gone */ }
    }
    out.push({ type: L.type, once: !!L.once, capture: !!L.useCapture, passive: !!L.passive, source, sourceLoc });
  }
  return { ok: true, count: out.length, listeners: out };
}

// ---- dispatch --------------------------------------------------------------

function dispatch(s, op, body) {
  switch (op) {
    case 'break': return setBreak(s, body);
    case 'list': return listBreaks(s);
    case 'remove': return removeBreak(s, body);
    case 'state': return buildState(s).then((st) => ({ ok: true, ...st }));
    case 'inspect': return inspect(s, body);
    case 'eval': return evalFrame(s, body);
    case 'step': return step(s, body);
    case 'resume': return resume(s);
    case 'pause': return pause(s);
    case 'screenshot': return screenshot(s);
    case 'listeners': return listeners(s, body);
    case 'coverage-start': return coverageStart(s);
    case 'coverage-stop': return coverageStop(s);
    default: throw gbErr(CODES.BAD_REQUEST, `unknown debug op '${op}'`, { field: 'op', valid_values: [...DIRECT, ...QUEUED] });
  }
}

/** Route POST /sessions/:name/debug {op, ...}. Direct-lane ops bypass the serial queue so they
 *  work while a paused action holds it; queue-lane ops (live-page) serialize and refuse while paused. */
export async function handleDebug(mgr, name, body = {}) {
  const s = mgr._get(name); // throws NO_SESSION
  const op = body.op;
  ensureDebugState(s);
  if (DIRECT.has(op)) return dispatch(s, op, body);
  if (QUEUED.has(op)) {
    if (s.debug && s.debug.paused) {
      throw gbErr(CODES.PAUSED, `cannot '${op}' while paused at a breakpoint`, {
        field: 'op', correction_hint: 'resume first (debug resume)', valid_values: ['resume', 'step', 'inspect', 'eval', 'state'],
      });
    }
    return mgr.runQueued(s, () => dispatch(s, op, body));
  }
  throw gbErr(CODES.BAD_REQUEST, `unknown debug op '${op}'`, { field: 'op', valid_values: [...DIRECT, ...QUEUED] });
}
