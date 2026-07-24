// M5 daemon additions: standalone eval / screenshot / targeted wait / artifact listing. Each
// runs on a session already checked-not-paused by handleAction (so all four honor the PAUSED lane:
// while a breakpoint holds the queue, these refuse fast rather than hang). Kept out of actions.mjs
// so the M2 action delta path stays legible; wired in via handleAction's dispatch + one GET route.
import fs from 'node:fs';
import path from 'node:path';
import { CODES, gbErr } from '../protocol.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Compact, bounded preview of a non-returnable Runtime.RemoteObject (mirrors debug.mjs). */
function previewOf(v) {
  if (!v) return 'undefined';
  if ('value' in v) { try { return JSON.stringify(v.value).slice(0, 200); } catch { return String(v.value).slice(0, 200); } }
  if (v.description) return String(v.description).slice(0, 200);
  if (v.unserializableValue) return String(v.unserializableValue).slice(0, 200);
  return String(v.type).slice(0, 200);
}

// ---- eval -------------------------------------------------------------------

/**
 * Runtime.evaluate in the live page (NOT while paused — that lane is debug eval-on-frame). Returns
 * the value by-value when serializable, else a bounded preview, plus any console emitted DURING the
 * eval (mark/since) so `console.log`-style debugging surfaces without a second read call.
 */
export async function evalExpression(session, body) {
  const expression = String(body.expression ?? '');
  if (!expression) throw gbErr(CODES.BAD_REQUEST, 'eval needs an `expression`', { field: 'expression', correction_hint: 'pass a JS expression string' });
  const awaitPromise = !!body.awaitPromise;
  const t0 = Date.now();
  const mark = session.console.mark();
  const { cdp } = session;
  const common = { expression, awaitPromise, generatePreview: true, userGesture: true };
  let r;
  try {
    r = await cdp.send('Runtime.evaluate', { ...common, returnByValue: true });
  } catch {
    // returnByValue rejects on a non-serializable result (functions, DOM nodes, cycles) — retry by-ref.
    r = await cdp.send('Runtime.evaluate', { ...common, returnByValue: false });
  }
  const consoleDelta = session.console.since(mark, 20);
  const tookMs = Date.now() - t0;
  session.journal.log('command', { op: 'eval', threw: !!r.exceptionDetails, tookMs });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception;
    return { ok: true, threw: true, error: (ex && ex.description) || r.exceptionDetails.text || 'eval threw', console: consoleDelta, tookMs };
  }
  const v = r.result || {};
  const out = { ok: true, type: v.type, console: consoleDelta, tookMs };
  if ('value' in v) out.value = v.value;
  else out.preview = previewOf(v);
  return out;
}

// ---- screenshot -------------------------------------------------------------

/** Union bounding box of a DOM quad [x1,y1,x2,y2,x3,y3,x4,y4]. */
function quadBox(q) {
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Standalone screenshot via CDP captureScreenshot (webp q70) → an on-disk path under shots/, never
 * inline bytes (Claude Code's 10-20x ImageContent tax, research 04 §4.6). `selector` clips to the
 * element's border box; `fullPage` captures beyond the viewport; `theme` temporarily emulates the
 * color-scheme then restores the session's own. Returns {ok, path, bytes, w, h} (w/h in CSS px).
 */
export async function screenshotAction(session, body) {
  const { cdp, page } = session;
  await cdp.send('Page.enable').catch(() => {});
  const theme = body.theme === 'light' || body.theme === 'dark' ? body.theme : null;
  if (theme) await page.emulateMedia({ colorScheme: theme }).catch(() => {});
  try {
    const params = { format: 'webp', quality: 70 };
    let w, h;
    if (body.selector) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(body.selector)})`, returnByValue: false });
      if (!result || !result.objectId) throw gbErr(CODES.NO_TARGET, `selector '${body.selector}' matched nothing to screenshot`, { field: 'selector', correction_hint: 'check the selector' });
      let box;
      try { box = (await cdp.send('DOM.getBoxModel', { objectId: result.objectId })).model; }
      finally { cdp.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {}); }
      const b = quadBox(box.border);
      if (b.width < 1 || b.height < 1) throw gbErr(CODES.NO_TARGET, `selector '${body.selector}' has a zero-size box`, { field: 'selector' });
      params.clip = { x: b.x, y: b.y, width: b.width, height: b.height, scale: 1 };
      w = Math.round(b.width); h = Math.round(b.height);
    } else if (body.fullPage) {
      params.captureBeyondViewport = true;
      const m = await cdp.send('Page.getLayoutMetrics').catch(() => null);
      const cs = m && (m.cssContentSize || m.contentSize);
      w = cs ? Math.round(cs.width) : null; h = cs ? Math.round(cs.height) : null;
    } else {
      const m = await cdp.send('Page.getLayoutMetrics').catch(() => null);
      const vp = m && (m.cssLayoutViewport || m.layoutViewport);
      w = vp ? Math.round(vp.clientWidth) : null; h = vp ? Math.round(vp.clientHeight) : null;
    }
    const { data } = await cdp.send('Page.captureScreenshot', params);
    const buf = Buffer.from(data, 'base64');
    const p = session.journal.alloc('shots', `shot-${Date.now()}.webp`);
    fs.writeFileSync(p, buf);
    session.journal.log('command', { op: 'screenshot', path: p, bytes: buf.length });
    return { ok: true, path: p, bytes: buf.length, w, h };
  } finally {
    if (theme) await page.emulateMedia({ colorScheme: session.colorScheme || null }).catch(() => {});
  }
}

// ---- wait -------------------------------------------------------------------

/**
 * Targeted wait, distinct from settle: block until ONE named condition holds, or the budget lapses.
 * `for`: {selector} (visible) | {text} (substring in body) | {url} (substring of location.href) |
 * {hydration:true} (no astro-island[ssr]) | {timeout:ms} (a plain sleep). NEVER throws on timeout —
 * returns {ok, matched:false} so the agent can branch instead of catching. A missing/blank `for`
 * (nothing to wait on) is the one BAD_REQUEST.
 */
export async function waitFor(session, body) {
  const spec = body.for || {};
  const t0 = Date.now();
  const timeoutMs = body.timeoutMs > 0 ? Math.min(Number(body.timeoutMs), 120000) : 10000;
  const { page } = session;
  try {
    if (spec.selector) {
      await page.waitForSelector(spec.selector, { state: 'visible', timeout: timeoutMs });
    } else if (spec.text != null && spec.text !== '') {
      await page.waitForFunction((t) => !!document.body && document.body.innerText.includes(t), spec.text, { timeout: timeoutMs, polling: 100 });
    } else if (spec.url != null && spec.url !== '') {
      await page.waitForFunction((u) => location.href.includes(u), spec.url, { timeout: timeoutMs, polling: 100 });
    } else if (spec.hydration) {
      await page.waitForFunction(() => !document.querySelector('astro-island[ssr]'), undefined, { timeout: timeoutMs, polling: 100 });
    } else if (spec.timeout != null) {
      await delay(Math.min(Number(spec.timeout) || 0, timeoutMs));
    } else {
      throw gbErr(CODES.BAD_REQUEST, 'wait needs `for` with one of: selector|text|url|hydration|timeout', {
        field: 'for', valid_values: ['selector', 'text', 'url', 'hydration', 'timeout'],
        correction_hint: 'e.g. for:{selector:"#done"} or for:{text:"Loaded"}',
      });
    }
    const tookMs = Date.now() - t0;
    session.journal.log('command', { op: 'wait', matched: true, tookMs });
    return { ok: true, matched: true, tookMs };
  } catch (e) {
    if (e && e.gb) throw e; // a real BAD_REQUEST (bad `for`) — surface it
    const tookMs = Date.now() - t0;
    session.journal.log('command', { op: 'wait', matched: false, tookMs });
    return { ok: true, matched: false, tookMs }; // timeout / detach — never throw
  }
}

// ---- artifacts --------------------------------------------------------------

/** List a session's on-disk artifacts grouped by kind (shots/reports/net/journal), newest first. */
export function listArtifacts(session) {
  const j = session.journal;
  const groups = { shots: j.shots, reports: j.reports, net: j.net, journal: j.dir };
  const artifacts = {};
  for (const [kind, d] of Object.entries(groups)) {
    const files = [];
    let names = [];
    try { names = fs.readdirSync(d); } catch { names = []; }
    for (const name of names) {
      const fp = path.join(d, name);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (st.isDirectory()) continue; // 'journal' kind: dir listing skips the shots/reports/net subdirs
      files.push({ rel: path.relative(j.dir, fp), path: fp, bytes: st.size, mtime: Math.round(st.mtimeMs) });
    }
    artifacts[kind] = files.sort((a, b) => b.mtime - a.mtime);
  }
  return { ok: true, dir: j.dir, artifacts };
}
