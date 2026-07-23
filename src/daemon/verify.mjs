// Verification engine (arch §5) — the one-call bundle. `verify` settles the page, then collects
// every channel (console/page errors, network taxonomy, layout pathology, a11y, build-error
// overlay), optionally sweeps theme×viewport, writes full detail + screenshots to the session
// artifact dir, and returns a COMPACT report: counts + the top ~20 actionable findings + artifact
// paths. Findings are sentences the fixing agent can act on ("2 requests failed: GET /api/x →
// net::ERR_CONNECTION_REFUSED"), never raw dumps. `read` is the cursored, taxonomized sibling for
// pulling one channel at a time (console|network|errors|overlay), remapped through sourcemaps.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CODES, gbErr } from '../protocol.mjs';
import { settle } from './settle.mjs';
import { layoutAuditSource } from './layout-audit.mjs';
import { readOverlay } from './overlay-reader.mjs';
import { sourceMapper } from './sourcemaps.mjs';

const DEFAULT_VIEWPORTS = [{ w: 390, h: 844, label: 'mobile' }, { w: 1280, h: 800, label: 'desktop' }];
const LAYOUT_CATS = ['overflow', 'occlusion', 'invisible', 'zeroSize', 'brokenImages', 'contrast', 'cls'];
// CLS is excluded from sweep re-runs — a viewport resize itself emits layout-shift entries that
// would be measurement noise, not a real regression.
const COMBO_CATS = ['overflow', 'occlusion', 'invisible', 'zeroSize', 'brokenImages', 'contrast'];
const RANK = { error: 0, warn: 1, info: 2 };
const raf = (page) => page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))').catch(() => {});
const safe = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 40);

let AXE_SRC = null;
function axeSource() {
  if (AXE_SRC == null) {
    try { AXE_SRC = fs.readFileSync(fileURLToPath(new URL('../../vendor/axe.min.js', import.meta.url)), 'utf8'); }
    catch { AXE_SRC = ''; }
  }
  return AXE_SRC;
}

// ---- per-channel collectors -------------------------------------------------

async function runLayout(page, scope) {
  try { return await page.evaluate(layoutAuditSource({ scope })); }
  catch { return null; }
}
function flattenLayout(layout, cats) {
  const out = [];
  if (!layout) return out;
  for (const c of cats) for (const f of layout[c] || []) out.push(f);
  return out;
}

async function runAxe(page, scope) {
  const src = axeSource();
  if (!src) return { violations: [], note: 'axe unavailable' };
  try { await page.evaluate(src); } catch { return { violations: [], note: 'axe inject failed' }; }
  const options = { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'] };
  const runP = page
    .evaluate(({ ctx, opts }) => window.axe.run(ctx || document, opts), { ctx: scope ? { include: [scope] } : null, opts: options })
    .catch((e) => ({ error: String((e && e.message) || e) }));
  const res = await Promise.race([runP, new Promise((r) => setTimeout(() => r({ timeout: true }), 10000))]);
  if (!res || res.timeout || res.error) return { violations: [], note: res && res.timeout ? 'axe timed out (10s)' : (res && res.error) || 'axe failed' };
  return res;
}
/** Collapse structurally-identical violations (same rule + selector shape modulo nth-index). */
function dedupAxe(results) {
  const groups = new Map();
  for (const v of results?.violations || []) {
    for (const node of v.nodes || []) {
      const target = (Array.isArray(node.target) ? node.target.join(' ') : String(node.target || '')).slice(0, 120);
      const shape = target.replace(/:nth-child\(\d+\)/g, ':nth-child()').replace(/\[\d+\]/g, '[]');
      const key = v.id + '|' + shape;
      const g = groups.get(key) || { ruleId: v.id, impact: v.impact, help: v.help, sample: target, count: 0 };
      g.count += 1;
      groups.set(key, g);
    }
  }
  return [...groups.values()];
}

// ---- sweep application ------------------------------------------------------

async function applyCombo(session, theme, vp) {
  const { page } = session;
  if (vp) await page.setViewportSize({ width: vp.w, height: vp.h }).catch(() => {});
  if (theme) {
    await page.emulateMedia({ colorScheme: theme }).catch(() => {});
    if (session.themeAttr) await page.evaluate(([a, t]) => document.documentElement.setAttribute(a, t), [session.themeAttr, theme]).catch(() => {});
  }
  await raf(page);
}
async function restoreEmulation(session, origVp, origTheme) {
  const { page } = session;
  if (origVp) await page.setViewportSize(origVp).catch(() => {});
  await page.emulateMedia({ colorScheme: session.colorScheme || null }).catch(() => {});
  if (session.themeAttr) {
    await page.evaluate(([a, t]) => { if (t == null) document.documentElement.removeAttribute(a); else document.documentElement.setAttribute(a, t); }, [session.themeAttr, origTheme]).catch(() => {});
  }
}
async function shoot(session, n, label) {
  try {
    await session.cdp.send('Page.enable').catch(() => {});
    const { data } = await session.cdp.send('Page.captureScreenshot', { format: 'webp', quality: 70, captureBeyondViewport: false });
    const p = session.journal.alloc('shots', `verify-${n}-${safe(label)}.webp`);
    fs.writeFileSync(p, Buffer.from(data, 'base64'));
    return p;
  } catch { return null; }
}

// ---- finding builders -------------------------------------------------------

function errLoc(e) {
  if (e.orig) return `${e.orig.file}:${e.orig.line}` + (e.orig.col ? `:${e.orig.col}` : '');
  return e.loc || undefined;
}
function netFinding(kind, list, severity) {
  const first = list[0];
  const one = (r) => `${r.method || 'GET'} ${(() => { try { return new URL(r.url).pathname; } catch { return r.url; } })()}`;
  let summary;
  if (kind === 'failed') summary = `${list.length} request${list.length > 1 ? 's' : ''} failed: ${one(first)} → ${first.errorText}`;
  else if (kind === 'httpError') summary = `${list.length} request${list.length > 1 ? 's' : ''} returned an HTTP error: ${one(first)} → ${first.status}`;
  else if (kind === 'hanging') summary = `${list.length} request${list.length > 1 ? 's' : ''} still in-flight (hanging): ${one(first)} (>${Math.round((first.ageMs || 0) / 1000)}s)`;
  else summary = `${list.length} mixed-content warning${list.length > 1 ? 's' : ''}`;
  return { channel: 'network', severity, summary, detail: list.slice(0, 10).map((r) => (kind === 'mixed' ? r : `${one(r)}${r.status ? ' → ' + r.status : ''}${r.errorText ? ' → ' + r.errorText : ''}`)) };
}
function layoutFinding(f, combo) {
  const label = { overflow: 'Horizontal overflow', occlusion: 'Occluded interactive element', invisible: 'Invisible interactive element', zeroSize: 'Zero-size click target', brokenImage: 'Broken image', contrast: 'Low text contrast', cls: 'Layout shift (CLS)' }[f.type] || f.type;
  return { channel: 'layout', severity: 'warn', summary: `${label}: ${f.desc}${combo ? ` [${combo}]` : ''} — ${f.detail}`, selector: f.desc, ...(combo ? { combo } : {}) };
}

// ---- verify -----------------------------------------------------------------

/**
 * Run the full bundle. `opts`: {scope?, themes?, viewports?(bool|[{w,h,label}]), axe?=true,
 * screenshots?=true}. Returns the compact report; full detail is written to reports/verify-<n>.json.
 */
export async function verify(session, opts = {}) {
  const t0 = Date.now();
  const { page } = session;
  const scope = opts.scope || null;
  const wantAxe = opts.axe !== false;
  const wantShots = opts.screenshots !== false;

  if (scope) {
    const el = await page.$(scope).catch(() => null);
    if (!el) throw gbErr(CODES.NO_TARGET, `scope selector '${scope}' matched nothing to verify`, { field: 'scope', correction_hint: 'check the selector or drop scope to verify the whole page' });
    await el.dispose().catch(() => {});
  }

  const settleRes = await settle(session, {});
  const n = (session._verifyN = (session._verifyN || 0) + 1);
  const mapper = sourceMapper(session);

  // errors (scoped to the current page load via the nav mark; remapped through sourcemaps)
  const navMark = session._navMark || 0;
  const entries = session.console.entries(navMark);
  const consoleErrs = await Promise.all(entries.filter((e) => e.kind === 'error').map((e) => mapper.remapEntry(e)));
  const pageErrs = await Promise.all(entries.filter((e) => e.kind === 'pageerror').map((e) => mapper.remapEntry(e)));

  // network taxonomy (current page only; mixed-content from console strings)
  const consoleTexts = session.console.all().map((e) => e.text);
  const net = session.net.classify({ consoleTexts, sinceTs: session._navTs || 0 });

  // layout (baseline) + overlay + a11y
  const baseLayout = await runLayout(page, scope);
  const baseFindings = flattenLayout(baseLayout, LAYOUT_CATS);
  const overlay = await readOverlay(session);
  const axeRaw = wantAxe ? await runAxe(page, scope) : { violations: [], note: 'axe disabled' };
  const axeGroups = dedupAxe(axeRaw);

  // sweeps: theme × viewport. Combo-specific layout findings (not already seen at baseline) are
  // added tagged with the combo; each combo produces one screenshot.
  const shots = [];
  const comboFindings = [];
  const vpList = opts.viewports === true ? DEFAULT_VIEWPORTS : Array.isArray(opts.viewports) ? opts.viewports : null;
  const thList = opts.themes ? ['light', 'dark'] : null;
  const doSweep = !!(vpList || thList);
  const seen = new Set(baseFindings.map((f) => f.type + '|' + f.desc));

  if (doSweep) {
    const origVp = page.viewportSize();
    const origTheme = session.themeAttr ? await page.evaluate((a) => document.documentElement.getAttribute(a), session.themeAttr).catch(() => null) : null;
    const vps = vpList || [null];
    const ths = thList || [null];
    for (const th of ths) {
      for (const vp of vps) {
        const label = `${th || 'theme'}-${vp ? vp.label : 'vp'}`;
        await applyCombo(session, th, vp);
        if (wantShots) { const p = await shoot(session, n, label); if (p) shots.push(p); }
        const cl = flattenLayout(await runLayout(page, scope), COMBO_CATS);
        for (const f of cl) { const k = f.type + '|' + f.desc; if (!seen.has(k)) { seen.add(k); comboFindings.push(layoutFinding(f, label)); } }
      }
    }
    await restoreEmulation(session, origVp, origTheme);
  } else if (wantShots) {
    const p = await shoot(session, n, 'baseline');
    if (p) shots.push(p);
  }

  // ---- assemble findings ----
  const findings = [];
  for (const e of consoleErrs) findings.push({ channel: 'console', severity: 'error', summary: `console.error: ${e.text.slice(0, 200)}`, detail: errLoc(e) });
  for (const e of pageErrs) findings.push({ channel: 'pageerror', severity: 'error', summary: `Uncaught: ${e.text.slice(0, 200)}`, detail: errLoc(e) });
  if (net.failed.length) findings.push(netFinding('failed', net.failed, 'error'));
  if (net.httpError.length) findings.push(netFinding('httpError', net.httpError, 'error'));
  if (net.hanging.length) findings.push(netFinding('hanging', net.hanging, 'warn'));
  if (net.mixedContent.length) findings.push(netFinding('mixed', net.mixedContent, 'warn'));
  if (overlay) findings.push({ channel: 'overlay', severity: 'error', summary: `Build error (${overlay.framework}): ${String(overlay.message).slice(0, 200)}`, detail: [overlay.file, overlay.frame].filter(Boolean).join('\n').slice(0, 800) });
  for (const f of baseFindings) findings.push(layoutFinding(f));
  for (const f of comboFindings) findings.push(f);
  for (const g of axeGroups) findings.push({ channel: 'a11y', severity: g.impact === 'critical' || g.impact === 'serious' ? 'warn' : 'info', summary: `${g.help} (${g.count}×): ${g.sample}`, selector: g.sample, detail: `rule ${g.ruleId} (${g.impact})` });

  findings.sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3));

  const layoutCount = baseFindings.length + comboFindings.length;
  const counts = {
    consoleErrors: consoleErrs.length, pageErrors: pageErrs.length,
    netFailed: net.failed.length, netHttpError: net.httpError.length, netHanging: net.hanging.length, netMixed: net.mixedContent.length,
    a11y: axeGroups.length, layout: layoutCount,
  };
  // ok = no errors/pathologies. a11y is advisory (never flips ok — "no automated violations" ≠
  // accessible, and axe noise must not gate; guardrail-safe) and reported in counts only.
  const ok = counts.consoleErrors === 0 && counts.pageErrors === 0 && counts.netFailed === 0 &&
    counts.netHttpError === 0 && counts.netHanging === 0 && counts.netMixed === 0 && counts.layout === 0 && !overlay;

  // ---- artifacts ----
  const netlogPath = session.journal.alloc('net', `verify-${n}.json`);
  try { fs.writeFileSync(netlogPath, JSON.stringify({ taxonomy: net, all: session.net.all() }, null, 0)); } catch { /* disk */ }
  let axePath;
  if (wantAxe) { axePath = session.journal.alloc('reports', `axe-${n}.json`); try { fs.writeFileSync(axePath, JSON.stringify(axeRaw)); } catch { /* disk */ } }
  const reportPath = session.journal.alloc('reports', `verify-${n}.json`);
  const full = {
    ok, settled: settleRes.settled, settleWhy: settleRes.why, url: page.url(), counts,
    findings, // uncapped on disk
    errors: { console: consoleErrs, page: pageErrs },
    network: net, layout: baseLayout, sweep: comboFindings, overlay, a11y: axeGroups,
    artifacts: { screenshots: shots, axe: axePath, netlog: netlogPath }, tookMs: 0,
  };
  full.tookMs = Date.now() - t0;
  try { fs.writeFileSync(reportPath, JSON.stringify(full, null, 2)); } catch { /* disk */ }

  session.journal.log('command', { op: 'verify', ok, counts, report: reportPath });

  return {
    ok, settled: settleRes.settled, url: page.url(), counts,
    findings: findings.slice(0, 20),
    artifacts: { report: reportPath, screenshots: shots, ...(axePath ? { axe: axePath } : {}), netlog: netlogPath },
    tookMs: Date.now() - t0,
  };
}

// ---- read (cursored, taxonomized single channel) ----------------------------

const shapeEntry = (e) => ({ id: e.id, kind: e.kind, text: e.text, ...(e.loc ? { loc: e.loc } : {}), ...(e.orig ? { orig: e.orig } : {}) });

/** `read` one channel: console | network | errors | overlay. Paginated + source-map-remapped. */
export async function read(session, opts = {}) {
  const channel = opts.channel || 'errors';
  const mapper = sourceMapper(session);

  if (channel === 'overlay') return { ok: true, channel, overlay: await readOverlay(session) };
  if (channel === 'network') {
    const net = session.net.classify({ consoleTexts: session.console.all().map((e) => e.text) });
    return { ok: true, channel, counts: { failed: net.failed.length, httpError: net.httpError.length, hanging: net.hanging.length, mixedContent: net.mixedContent.length }, network: net };
  }
  let kinds;
  if (channel === 'console') kinds = new Set(['log', 'warn', 'error']);
  else if (channel === 'errors') kinds = new Set(['error', 'pageerror']);
  else throw gbErr(CODES.BAD_CHANNEL, `unknown read channel '${channel}'`, { field: 'channel', valid_values: ['console', 'network', 'errors', 'overlay'] });

  const since = opts.since > 0 ? opts.since : 0;
  const limit = opts.limit > 0 ? Math.min(opts.limit, 200) : 50;
  const all = session.console.entries(since, kinds);
  const view = all.slice(0, limit);
  const remapped = await Promise.all(view.map((e) => (e.stack || e.loc ? mapper.remapEntry(e) : e)));
  const nextCursor = all.length > limit ? view[view.length - 1].id : null;
  return { ok: true, channel, count: all.length, shown: view.length, cursor: since, nextCursor, entries: remapped.map(shapeEntry) };
}
