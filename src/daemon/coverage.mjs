// Coverage: "what shipped but never ran" (arch §6, research 02 §8). JS precise coverage
// (Profiler, callCount+detailed) answers "this handler was never invoked" (count===0) and CSS
// rule-usage tracking answers "this rule never matched anything." Both are source-mapped and
// filtered to same-origin scripts (extension/injected code is noise the fixing agent can't act on).
//
// Caveat (research 02 §8): coverage for code that ran BEFORE start is incomplete — module
// top-level runs at load, so if start is called after navigation those functions read count 0.
// We report per-function counts truthfully; the meaningful signal is a never-invoked *handler*.
import fs from 'node:fs';
import { CODES, gbErr } from '../protocol.mjs';
import { sourceMapper } from './sourcemaps.mjs';

function shortUrl(url) {
  if (!url) return '';
  try { return new URL(url).pathname || url; } catch { return String(url).slice(0, 120); }
}
function sameOrigin(url, origin) {
  return !!url && origin && url.startsWith(origin) && /^https?:/.test(url);
}
function offsetToLine(src, offset) {
  let line = 0;
  const end = Math.min(offset, src.length);
  for (let i = 0; i < end; i++) if (src.charCodeAt(i) === 10) line++;
  return line; // 0-based
}
async function getSource(cdp, cache, scriptId) {
  if (cache.has(scriptId)) return cache.get(scriptId);
  let src = '';
  try { src = (await cdp.send('Debugger.getScriptSource', { scriptId })).scriptSource || ''; } catch { /* not retained */ }
  cache.set(scriptId, src);
  return src;
}

/** Collect stylesheet headers so coverage-stop can enumerate ALL rules (used + never-considered). */
function trackSheets(s) {
  if (s._cssSheets) return;
  s._cssSheets = new Map();
  s.cdp.on('CSS.styleSheetAdded', (p) => { if (p.header) s._cssSheets.set(p.header.styleSheetId, p.header); });
}

export async function coverageStart(s) {
  const { cdp } = s;
  trackSheets(s);
  await cdp.send('DOM.enable').catch(() => {});
  await cdp.send('Profiler.enable').catch(() => {});
  await cdp.send('Debugger.enable').catch(() => {}); // getScriptSource needs it
  await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true, allowTriggeredUpdates: false }).catch(() => {});
  let css = false;
  try { await cdp.send('CSS.enable'); await cdp.send('CSS.startRuleUsageTracking'); css = true; } catch { /* CSS domain unavailable */ }
  if (!s.debug) s.debug = {};
  s.debug.coverage = { started: Date.now(), css };
  s.journal.log('debug', { event: 'coverage-start', css });
  return { ok: true, css, note: 'start BEFORE navigating (then interact) for accurate coverage (research 02 §8)' };
}

/** Enumerate top-level CSS rules (brace-matched) from stylesheet text, recursing one level into
 *  @-blocks like @media. Returns [{selector, start, end}] offsets — used to diff against usage. */
function enumerateRules(text, base = 0) {
  const rules = [];
  let i = 0; const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (text[i] === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (i >= n) break;
    const start = i;
    while (i < n && text[i] !== '{' && text[i] !== '}') i++;
    if (i >= n || text[i] === '}') { i++; continue; }
    const selector = text.slice(start, i).replace(/\s+/g, ' ').trim();
    const blockStart = i; let depth = 0;
    for (; i < n; i++) { if (text[i] === '{') depth++; else if (text[i] === '}') { depth--; if (depth === 0) { i++; break; } } }
    if (selector.startsWith('@')) {
      const inner = text.slice(blockStart + 1, i - 1);
      for (const r of enumerateRules(inner, base + blockStart + 1)) rules.push(r);
    } else {
      rules.push({ selector: selector.slice(0, 120), start: base + start, end: base + i });
    }
  }
  return rules;
}

/** Unused CSS = rules enumerated from each same-origin sheet whose range no USED range overlaps. */
async function computeCssUnused(s, usedRanges) {
  const { cdp } = s;
  let origin = ''; try { origin = new URL(s.page.url()).origin; } catch { /* about:blank */ }
  const usedBySheet = new Map();
  for (const u of usedRanges) { const a = usedBySheet.get(u.styleSheetId) || []; a.push(u); usedBySheet.set(u.styleSheetId, a); }
  let total = 0; const unused = [];
  for (const [id, header] of s._cssSheets || []) {
    if (header.origin === 'user-agent' || header.origin === 'injected') continue;
    if (header.sourceURL && origin && !header.sourceURL.startsWith(origin)) continue;
    let text = '';
    try { text = (await cdp.send('CSS.getStyleSheetText', { styleSheetId: id })).text || ''; } catch { continue; }
    const rules = enumerateRules(text);
    const used = usedBySheet.get(id) || [];
    for (const r of rules) {
      total++;
      const isUsed = used.some((u) => u.startOffset < r.end && u.endOffset > r.start);
      if (!isUsed) unused.push(r.selector);
    }
  }
  return { total, unused };
}

export async function coverageStop(s) {
  const { cdp } = s;
  const cov = s.debug && s.debug.coverage;
  if (!cov) throw gbErr(CODES.BAD_REQUEST, 'coverage was not started', { field: 'op', correction_hint: 'call coverage-start first' });
  let origin = '';
  try { origin = new URL(s.page.url()).origin; } catch { /* about:blank */ }

  // --- JS ---
  let scripts = [];
  try { scripts = (await cdp.send('Profiler.takePreciseCoverage')).result || []; } catch { /* not enabled */ }
  await cdp.send('Profiler.stopPreciseCoverage').catch(() => {});
  const mapper = sourceMapper(s);
  const srcCache = new Map();
  const functions = [];
  for (const script of scripts) {
    if (!sameOrigin(script.url, origin)) continue;
    const src = await getSource(cdp, srcCache, script.scriptId);
    for (const fn of script.functions || []) {
      const top = (fn.ranges && fn.ranges[0]) || { count: 0, startOffset: 0 };
      const line0 = offsetToLine(src, top.startOffset || 0);
      let file = shortUrl(script.url); let line = line0 + 1;
      const orig = await mapper.remapLoc(`${script.url}:${line}:1`).catch(() => null);
      if (orig) { file = orig.file; line = orig.line; }
      functions.push({ functionName: fn.functionName || '(anonymous)', file, line, count: top.count || 0 });
    }
  }
  const neverRan = functions.filter((f) => f.count === 0).map(({ functionName, file, line }) => ({ functionName, file, line }));
  const ranCount = functions.length - neverRan.length;

  // --- CSS --- (stopRuleUsageTracking returns only USED rules; unused = all-sheet-rules − used)
  let cssReport = { tracked: false };
  if (cov.css) {
    let ruleUsage = [];
    try { ruleUsage = (await cdp.send('CSS.stopRuleUsageTracking')).ruleUsage || []; } catch { /* not tracking */ }
    const usedRanges = ruleUsage.filter((r) => r.used);
    const { total, unused } = await computeCssUnused(s, usedRanges);
    cssReport = { tracked: true, totalRules: total, unusedRules: unused.length, topUnused: unused.slice(0, 15) };
  }

  s.debug.coverage = null;
  const n = (s._covN = (s._covN || 0) + 1);
  const full = { origin, js: { functions, neverRan, neverRanCount: neverRan.length, ranCount }, css: cssReport };
  const report = s.journal.alloc('reports', `coverage-${n}.json`);
  try { fs.writeFileSync(report, JSON.stringify(full, null, 2)); } catch { /* disk */ }
  s.journal.log('debug', { event: 'coverage-stop', neverRan: neverRan.length, cssUnused: cssReport.unusedRules, report });

  return {
    ok: true,
    js: { neverRanCount: neverRan.length, ranCount, neverRan: neverRan.slice(0, 15) },
    css: cov.css ? { unusedRules: cssReport.unusedRules, totalRules: cssReport.totalRules, topUnused: cssReport.topUnused } : { tracked: false },
    report,
  };
}
