// Verification engine (arch §5) — the one-call bundle. `verify` settles the page, then collects
// every channel (console/page errors, network taxonomy, layout pathology, a11y, build-error
// overlay), optionally sweeps theme×viewport, writes full detail + screenshots to the session
// artifact dir, and returns a COMPACT report: counts + the top ~20 actionable findings + artifact
// paths. Findings are sentences the fixing agent can act on ("2 requests failed: GET /api/x →
// net::ERR_CONNECTION_REFUSED"), never raw dumps. `read` is the cursored, taxonomized sibling for
// pulling one channel at a time (console|network|errors|overlay), remapped through sourcemaps.
import fs from 'node:fs';
import crypto from 'node:crypto';
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
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
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

/**
 * Apply one sweep leg. Three mechanisms, because no one of them tests the others (arch §5):
 * `emulateMedia` (the OS signal), the site's own `data-theme` attribute, and — new — the site's
 * own root CLASS (`themeClass`, Tailwind's `darkMode:['class']`, the single most common dark-mode
 * mechanism in this ecosystem; defect D3).
 *
 * And the leg RELOADS (defect D2): a site that reads `prefers-color-scheme` once at module load
 * and applies a class from it — the DegreeForge/`useTheme` shape — cannot see a runtime emulation
 * flip at all, so the "dark" screenshot silently came out identical to light. Emulation is set
 * BEFORE the reload so boot-time readers observe it; the attribute/class are applied AFTER, so
 * they win over whatever the app's own boot code decided.
 */
async function applyCombo(session, theme, vp, opts = {}) {
  const { page } = session;
  if (vp) await page.setViewportSize({ width: vp.w, height: vp.h }).catch(() => {});
  if (theme) {
    await page.emulateMedia({ colorScheme: theme }).catch(() => {});
    if (opts.reload) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await settle(session, { navigation: true });
    }
    if (session.themeAttr) await page.evaluate(([a, t]) => document.documentElement.setAttribute(a, t), [session.themeAttr, theme]).catch(() => {});
    if (session.themeClass) await page.evaluate(([c, on]) => document.documentElement.classList.toggle(c, on), [session.themeClass, theme === 'dark']).catch(() => {});
  }
  await raf(page);
}
async function restoreEmulation(session, origVp, origTheme, origClass, reloaded) {
  const { page } = session;
  if (origVp) await page.setViewportSize(origVp).catch(() => {});
  await page.emulateMedia({ colorScheme: session.colorScheme || null }).catch(() => {});
  // The sweep's reloads left the page booted under the LAST leg's emulation; put it back on the
  // session's own footing so the next command sees the page the caller thinks it has.
  if (reloaded) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await settle(session, { navigation: true });
  }
  if (session.themeAttr) {
    await page.evaluate(([a, t]) => { if (t == null) document.documentElement.removeAttribute(a); else document.documentElement.setAttribute(a, t); }, [session.themeAttr, origTheme]).catch(() => {});
  }
  if (session.themeClass) {
    await page.evaluate(([c, on]) => document.documentElement.classList.toggle(c, on), [session.themeClass, !!origClass]).catch(() => {});
  }
}
// Page.captureScreenshot can wait on a compositor frame the page may never produce (a frozen main
// thread, a backgrounded target under a parallel run). A capture is an ATTACHMENT to the report, so
// it is bounded and degrades to null — a screenshot must never be able to wedge a verify.
const SHOT_CAP_MS = 20000;

async function shoot(session, n, label) {
  try {
    await session.cdp.send('Page.enable').catch(() => {});
    const shot = session.cdp.send('Page.captureScreenshot', { format: 'webp', quality: 70, captureBeyondViewport: false }).catch(() => null);
    const res = await Promise.race([shot, delay(SHOT_CAP_MS).then(() => null)]);
    if (!res) return null;
    const p = session.journal.alloc('shots', `verify-${n}-${safe(label)}.webp`);
    const buf = Buffer.from(res.data, 'base64');
    fs.writeFileSync(p, buf);
    // The hash is what makes "your dark screenshot is the light one" observable at all (D2).
    return { path: p, hash: crypto.createHash('sha1').update(buf).digest('hex') };
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

// ---- load state: cold vs warm (defect W3) -----------------------------------
// The WCII dogfood watched two real findings vanish on a warm reload — a `/favicon.ico` 404 and a
// CLS of 0.1734 — with nothing in the report saying the measurement conditions had changed. That
// is a false all-clear, the worst failure mode this tool has.
//
// Investigation (test/bugzoo/cache.html + /counts): `Network.setCacheDisabled(true)` IS applied and
// DOES work — every renderer-initiated sub-resource is re-fetched on every navigation (3 loads → 3
// server hits for a `max-age=600` script). What escapes it is (a) Chrome's IMPLICIT /favicon.ico
// probe, issued by the BROWSER process outside the page session's Network domain and negatively
// cached per profile (measured: 3 navigations → 1 request), and (b) CLS itself, which is a race
// between first paint and a resource arriving — a warm load wins that race even with a cold cache.
// Neither is fixable by a flag, so the honest answers are: label the load state, offer a real cold
// run, and say so when the numbers were measured warm.

/** Cold-navigate in place: clear the HTTP cache, then re-navigate cache-bypassed. */
async function coldNavigate(session) {
  const { page, cdp } = session;
  const url = page.url();
  if (!url || url === 'about:blank') return { done: false, why: 'no page is loaded to reload' };
  await cdp.send('Network.clearBrowserCache').catch(() => {});
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
  try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); }
  catch { return { done: false, why: 'reload timed out' }; }
  await settle(session, { navigation: true });
  return { done: true };
}

/** Describe the load state the current document was measured in. */
function navState(session, coldRun) {
  const nav = session._nav || { docLoads: 0, byUrl: new Map(), sameDoc: false };
  const url = session.page.url();
  const urlLoads = nav.byUrl.get(url) || 0;
  if (coldRun && coldRun.done) {
    return { kind: 'cold', reason: 'forced: HTTP cache cleared and the page re-navigated for this run', documentLoads: nav.docLoads, urlLoads, sameDocument: false, forced: true };
  }
  const base = { documentLoads: nav.docLoads, urlLoads, sameDocument: !!nav.sameDoc, forced: false };
  if (nav.sameDoc) return { kind: 'warm', reason: 'same-document navigation — no fresh document since the last load', ...base };
  // <=1 rather than ===1: a page whose `load` never fires (a hanging subresource) is still a first
  // load, and must not be mislabelled warm.
  if (nav.docLoads <= 1 && urlLoads <= 1) return { kind: 'cold', reason: 'first document load in this session', ...base };
  if (urlLoads > 1) return { kind: 'warm', reason: `this URL has been loaded ${urlLoads}× in this session`, ...base };
  return { kind: 'warm', reason: `the session already loaded ${nav.docLoads} document(s) — sockets, DNS and browser-side caches are warm`, ...base };
}

// ---- expected-404 allowlist (defect W4) -------------------------------------

/** Does `url`'s pathname match one allowlist entry? Exact, or a `*` glob. */
function matches404(url, patterns) {
  let pathname = url;
  try { pathname = new URL(url).pathname; } catch { /* keep the raw string */ }
  for (const raw of patterns) {
    const p = String(raw || '').trim();
    if (!p) continue;
    if (p === pathname) return p;
    if (p.includes('*')) {
      const rx = new RegExp('^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      if (rx.test(pathname)) return p;
    }
  }
  return null;
}

// ---- verify -----------------------------------------------------------------

/**
 * Run the full bundle. `opts`: {scope?, themes?, viewports?(bool|[{w,h,label}]), axe?=true,
 * screenshots?=true, themeReload?=true, cold?=false, ignore404?:string[]}. Returns the compact
 * report; full detail is written to reports/verify-<n>.json.
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

  // COLD (defect W3): a warm reload silently drops first-load findings — a negative-cached 404
  // never re-requests, and CLS is a first-paint race a warm load simply wins. `cold:true` clears
  // the HTTP cache and re-navigates before measuring so those are captured faithfully.
  const coldRun = opts.cold === true ? await coldNavigate(session) : null;

  const settleRes = await settle(session, {});
  const n = (session._verifyN = (session._verifyN || 0) + 1);
  const mapper = sourceMapper(session);

  // errors (scoped to the current page load via the nav mark; remapped through sourcemaps)
  const navMark = session._navMark || 0;
  const entries = session.console.entries(navMark);
  const allConsoleErrs = await Promise.all(entries.filter((e) => e.kind === 'error').map((e) => mapper.remapEntry(e)));
  const pageErrs = await Promise.all(entries.filter((e) => e.kind === 'pageerror').map((e) => mapper.remapEntry(e)));

  // network taxonomy (current page only; mixed-content from console strings)
  const consoleTexts = session.console.all().map((e) => e.text);
  const net = session.net.classify({ consoleTexts, sinceTs: session._navTs || 0 });

  // W4 — expected-404 allowlist. ONLY status-404 rows are demoted: the same path failing with a
  // 500 or a transport error still reports normally (an allowlist that hid those would re-create
  // exactly the false all-clear W3 is about). Demoted rows are kept in the on-disk report.
  const ignoreList = [...(session.ignore404 || []), ...(Array.isArray(opts.ignore404) ? opts.ignore404 : [])];
  const ignored404 = [];
  if (ignoreList.length) {
    const keep = [];
    for (const r of net.httpError) {
      const hit = r.status === 404 ? matches404(r.url, ignoreList) : null;
      if (hit) ignored404.push({ ...r, ignoredBy: hit }); else keep.push(r);
    }
    net.httpError = keep;
  }
  // The browser also logs a console error for each of those 404s ("Failed to load resource: …404"),
  // located AT the resource URL. Demote exactly those — matched by URL against the rows we just
  // demoted, so a 500 on the same path keeps its console error.
  const ignoredUrls = new Set(ignored404.map((r) => r.url));
  const consoleErrs = [], ignoredConsole = [];
  for (const e of allConsoleErrs) {
    const isResourceErr = /failed to load resource/i.test(e.text || '') && [...ignoredUrls].some((u) => (e.loc || '').startsWith(u));
    if (isResourceErr) ignoredConsole.push(e); else consoleErrs.push(e);
  }

  // layout (baseline) + overlay + a11y
  const baseLayout = await runLayout(page, scope);
  const baseFindings = flattenLayout(baseLayout, LAYOUT_CATS);
  const overlay = await readOverlay(session);
  const axeRaw = wantAxe ? await runAxe(page, scope) : { violations: [], note: 'axe disabled' };
  const axeGroups = dedupAxe(axeRaw);

  // sweeps: theme × viewport. Combo-specific layout findings (not already seen at baseline) are
  // added tagged with the combo; each combo produces one screenshot.
  const shots = [];
  const shotIndex = []; // {theme, vp, hash, path} — feeds the identical-across-themes check
  const comboFindings = [];
  const vpList = opts.viewports === true ? DEFAULT_VIEWPORTS : Array.isArray(opts.viewports) ? opts.viewports : null;
  const thList = opts.themes ? ['light', 'dark'] : null;
  const doSweep = !!(vpList || thList);
  const seen = new Set(baseFindings.map((f) => f.type + '|' + f.desc));
  // Reload per theme leg by default (D2); `themeReload:false` opts out for a page whose in-page
  // state (a filled form, an opened panel) must survive the sweep.
  const themeReload = opts.themeReload !== false;

  if (doSweep) {
    const origVp = page.viewportSize();
    const origTheme = session.themeAttr ? await page.evaluate((a) => document.documentElement.getAttribute(a), session.themeAttr).catch(() => null) : null;
    const origClass = session.themeClass ? await page.evaluate((c) => document.documentElement.classList.contains(c), session.themeClass).catch(() => false) : false;
    const vps = vpList || [null];
    const ths = thList || [null];
    for (const th of ths) {
      for (const vp of vps) {
        // Named by the AXIS ACTUALLY SWEPT (defect D9): 'dark', 'vp-mobile', 'dark-vp-mobile' —
        // never 'theme-mobile' for a viewport-only run, and collision-free when both axes run.
        const label = [th || null, vp ? `vp-${vp.label}` : null].filter(Boolean).join('-');
        await applyCombo(session, th, vp, { reload: themeReload });
        if (wantShots) {
          const s = await shoot(session, n, label);
          if (s) { shots.push(s.path); shotIndex.push({ theme: th, vp: vp ? vp.label : null, hash: s.hash, path: s.path }); }
        }
        const cl = flattenLayout(await runLayout(page, scope), COMBO_CATS);
        for (const f of cl) { const k = f.type + '|' + f.desc; if (!seen.has(k)) { seen.add(k); comboFindings.push(layoutFinding(f, label)); } }
      }
    }
    await restoreEmulation(session, origVp, origTheme, origClass, !!(thList && themeReload));
  } else if (wantShots) {
    const s = await shoot(session, n, 'baseline');
    if (s) shots.push(s.path);
  }

  // Identical light/dark output is itself a finding (D2): either the site has no dark mode, or the
  // sweep never reached the mechanism it uses — both are things the reviewer must be told, because
  // the alternative is false confidence from an artifact that is silently the wrong theme.
  const themeFindings = [];
  if (thList && shotIndex.length >= 2) {
    for (const vpLabel of [...new Set(shotIndex.map((s) => s.vp))]) {
      const light = shotIndex.find((s) => s.theme === 'light' && s.vp === vpLabel);
      const dark = shotIndex.find((s) => s.theme === 'dark' && s.vp === vpLabel);
      if (light && dark && light.hash === dark.hash) {
        themeFindings.push({
          channel: 'theme', severity: 'warn',
          summary: `Light and dark screenshots are byte-identical${vpLabel ? ` at ${vpLabel}` : ''} — the theme sweep changed nothing on screen`,
          detail: `the page may have no dark styles at all, or its theme mechanism was not reached: set the session's themeAttr (data-theme) or themeClass (Tailwind's 'dark') so the sweep can drive it. Shots: ${light.path} == ${dark.path}`,
        });
      }
    }
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
  for (const f of themeFindings) findings.push(f);
  // ONE info line for a whole modal's worth of intentionally-buried controls (defect D4).
  if (baseLayout?.modal?.behind > 0) {
    findings.push({
      channel: 'layout', severity: 'info',
      summary: `Modal open (${baseLayout.modal.desc}); ${baseLayout.modal.behind} interactive element${baseLayout.modal.behind > 1 ? 's are' : ' is'} behind its backdrop`,
      detail: 'expected while a dialog is open — occlusion warnings for those elements are suppressed, not lost',
    });
  }
  // ONE info line per deferred (content-visibility:auto) section — not pathology (defect W1).
  for (const g of baseLayout?.deferred || []) {
    findings.push({
      channel: 'layout', severity: 'info',
      summary: `${g.count} interactive element${g.count > 1 ? 's' : ''} in deferred section ${g.desc} (content-visibility:auto, not yet painted); scroll to audit`,
      detail: `deferred rendering, not a hide: ${g.samples.join(', ')}${g.count > g.samples.length ? ', …' : ''} paint on scroll. Scroll the section into view and re-verify to audit its contrast/occlusion.`,
    });
  }
  if (ignored404.length) {
    findings.push({
      channel: 'network', severity: 'info',
      summary: `Ignored 404s: ${ignored404.length} (allowlisted: ${[...new Set(ignored404.map((r) => r.ignoredBy))].join(', ')})`,
      detail: ignored404.map((r) => { try { return new URL(r.url).pathname; } catch { return r.url; } }).join(', ') + ' — kept in the on-disk report under network.ignored404; only status-404 rows are demoted.',
    });
  }
  for (const g of axeGroups) findings.push({ channel: 'a11y', severity: g.impact === 'critical' || g.impact === 'serious' ? 'warn' : 'info', summary: `${g.help} (${g.count}×): ${g.sample}`, selector: g.sample, detail: `rule ${g.ruleId} (${g.impact})` });

  // The load-state caveat goes LAST among the warns (stable sort): it qualifies the whole report
  // rather than naming a defect, but it must be impossible to miss (defect W3c).
  const navigation = navState(session, coldRun);
  if (navigation.kind === 'warm') {
    findings.push({
      channel: 'navigation', severity: 'warn',
      summary: `Measured after a WARM load (${navigation.reason}) — first-load CLS and first-request failures may be understated`,
      detail: 'CLS is a first-paint race a warm load wins, and a negatively-cached 404 (e.g. /favicon.ico) is never re-requested. Re-run with cold:true (--cold), or measure in a fresh session, before believing a clean result.',
    });
  }

  findings.sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3));

  const layoutCount = baseFindings.length + comboFindings.length;
  // `consoleErrors` is exactly that — console.error entries SINCE THE LAST NAVIGATION (the nav
  // mark), not the whole buffer and not every log level. `gb_read {channel:'console'}` is the
  // unfiltered view. (Named for the dogfood observation: a field called `console` invited the
  // reading "all console output", which it never was.)
  const counts = {
    consoleErrors: consoleErrs.length, pageErrors: pageErrs.length,
    netFailed: net.failed.length, netHttpError: net.httpError.length, netHanging: net.hanging.length, netMixed: net.mixedContent.length,
    a11y: axeGroups.length, layout: layoutCount,
    ...(ignored404.length || ignoredConsole.length ? { ignored404: ignored404.length + ignoredConsole.length } : {}),
    ...(baseLayout?.deferred?.length ? { deferred: baseLayout.deferred.reduce((n2, g) => n2 + g.count, 0) } : {}),
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
    ok, settled: settleRes.settled, settleWhy: settleRes.why, url: page.url(), navigation, counts,
    findings, // uncapped on disk
    // Demoted rows are DEMOTED, never dropped: an allowlist that deletes evidence is a liability.
    errors: { console: consoleErrs, page: pageErrs, ...(ignoredConsole.length ? { ignored: ignoredConsole } : {}) },
    network: { ...net, ...(ignored404.length ? { ignored404 } : {}) },
    layout: baseLayout, sweep: comboFindings, theme: themeFindings,
    modal: baseLayout?.modal || null, deferred: baseLayout?.deferred || [], overlay, a11y: axeGroups,
    artifacts: { screenshots: shots, axe: axePath, netlog: netlogPath }, tookMs: 0,
  };
  full.tookMs = Date.now() - t0;
  try { fs.writeFileSync(reportPath, JSON.stringify(full, null, 2)); } catch { /* disk */ }

  session.journal.log('command', { op: 'verify', ok, counts, navigation: navigation.kind, report: reportPath });

  return {
    ok, settled: settleRes.settled, url: page.url(), navigation, counts,
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
