// The "why does this look wrong" tool (arch §6, spike 1, research 02 §5). CSS.getMatchedStylesForNode
// hands back EVERY candidate rule but no cascade winner and — critically — no specificity score
// (research 02 §5: RuleMatch has no specificity field; DevTools computes cascade resolution in JS).
// So we compute specificity ourselves (the (a,b,c) tuple) and resolve the winner per property from
// importance + origin + specificity + source order, marking each declaration won ✓ / overridden ✗.
// Plus: the inherited chain for inherited props, and effective fg-vs-composited-bg contrast (the
// spike-1 walk). Verbose by nature, so the inline result is capped (top 8 rules, longhand noise
// elided); full detail goes to reports/style-<n>.json.
import fs from 'node:fs';
import { CODES, gbErr } from '../protocol.mjs';

const KEY_PROPS = ['color', 'background-color', 'display', 'position', 'opacity', 'visibility', 'z-index', 'font-size', 'overflow'];
const INHERIT_PROPS = ['color', 'font-family', 'font-size', 'line-height', 'text-align', 'visibility'];
const ORIGIN_RANK = { 'user-agent': 0, user: 1, regular: 2, author: 2, inspector: 3 };

function shortUrl(url) { if (!url) return ''; try { return new URL(url).pathname || url; } catch { return String(url).slice(0, 120); } }

/**
 * CSS specificity (a,b,c) for one compound selector — ids / (classes|attrs|pseudo-classes) /
 * (elements|pseudo-elements). :where() contributes 0; :not()/:is()/:has() add their argument's.
 * Not a full selector parser (nested parens beyond one level are approximated) — ~30 lines, enough
 * to rank the common cases DevTools handles, since CDP ships no score (research 02 §5).
 */
export function specificity(sel) {
  let a = 0, b = 0, c = 0;
  let s = ' ' + String(sel || '').replace(/\s*[>+~]\s*/g, ' ') + ' ';
  s = s.replace(/::[\w-]+/g, () => { c++; return ' '; });                 // pseudo-elements
  s = s.replace(/:where\([^)]*\)/g, ' ');                                 // :where → 0
  s = s.replace(/:(?:not|is|has)\(([^)]*)\)/g, (_m, inner) => {           // functional pseudo → arg specificity
    const sp = specificity((inner || '').split(',')[0]); a += sp[0]; b += sp[1]; c += sp[2]; return ' ';
  });
  s = s.replace(/:[\w-]+(?:\([^)]*\))?/g, () => { b++; return ' '; });    // pseudo-classes
  s = s.replace(/\[[^\]]*\]/g, () => { b++; return ' '; });               // attribute selectors
  s = s.replace(/#[\w-]+/g, () => { a++; return ' '; });                  // ids
  s = s.replace(/\.[\w-]+/g, () => { b++; return ' '; });                 // classes
  s.replace(/[a-zA-Z][\w-]*/g, (t) => { if (t !== '*') c++; return t; }); // type selectors
  return [a, b, c];
}
const cmpKey = (d) => [d.important ? 1 : 0, ORIGIN_RANK[d.origin] ?? 2, d.inline ? 1 : 0, d.spec[0], d.spec[1], d.spec[2], d.order];
function greater(x, y) { for (let i = 0; i < x.length; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; }

/** Pull the author-written declarations out of a CDP CSSStyle (props WITH a source range are the
 *  ones the author typed; range-less entries are longhand expansions of a shorthand — elide them). */
function declsOf(style) {
  const props = (style && style.cssProperties) || [];
  const authored = props.filter((p) => p.range && !p.disabled);
  const base = authored.length ? authored : props.filter((p) => !p.disabled);
  return base.map((p) => ({ name: p.name, value: p.value, important: !!p.important }));
}

/** Flatten inlineStyle + matched rules into a rule list (each with computed specificity + order). */
function buildRules(matched) {
  const rules = [];
  let order = 0;
  if (matched.inlineStyle) {
    const decls = declsOf(matched.inlineStyle);
    if (decls.length) rules.push({ selector: '(inline style)', origin: 'author', inline: true, spec: [1, 0, 0], source: '(element style attr)', decls, order: order++ });
  }
  for (const m of matched.matchedCSSRules || []) {
    const rule = m.rule || {};
    const selectors = (rule.selectorList && rule.selectorList.selectors) || [];
    const matchIdx = (m.matchingSelectors && m.matchingSelectors.length) ? m.matchingSelectors : selectors.map((_, i) => i);
    // winning selector = the matched one with the highest specificity
    let best = [0, 0, 0]; let bestText = (rule.selectorList && rule.selectorList.text) || '*';
    for (const i of matchIdx) {
      const text = selectors[i] && selectors[i].text; if (!text) continue;
      const sp = specificity(text);
      if (greater(sp, best) || (bestText === undefined)) { best = sp; bestText = text; }
    }
    const decls = declsOf(rule.style);
    if (!decls.length) continue;
    rules.push({ selector: bestText, origin: rule.origin || 'author', inline: false, spec: best, source: ruleSource(rule), decls, order: order++ });
  }
  return rules;
}
function ruleSource(rule) {
  if (rule.origin === 'user-agent') return '(user agent)';
  const range = rule.style && rule.style.range;
  const line = range ? range.startLine + 1 : null;
  const url = rule.styleSheetId && rule._sourceURL; // best-effort; usually absent on inline <style>
  if (url) return `${shortUrl(url)}${line != null ? ':' + line : ''}`;
  return line != null ? `(stylesheet):${line}` : '(stylesheet)';
}

/** Resolve the winning declaration per property across all rules; annotate each decl won/overridden. */
function resolveCascade(rules) {
  const winners = new Map(); // prop -> {rule, decl}
  for (const rule of rules) {
    for (const d of rule.decls) {
      const cur = winners.get(d.name);
      const key = cmpKey({ ...d, origin: rule.origin, inline: rule.inline, spec: rule.spec, order: rule.order });
      if (!cur || greater(key, cur.key)) winners.set(d.name, { rule, decl: d, key });
    }
  }
  const annotated = rules.map((rule) => ({
    selector: rule.selector, source: rule.source, origin: rule.origin,
    specificity: rule.spec, maxKey: cmpKey({ important: false, origin: rule.origin, inline: rule.inline, spec: rule.spec, order: rule.order }),
    properties: rule.decls.map((d) => {
      const win = winners.get(d.name);
      const won = win && win.rule === rule && win.decl === d;
      return { name: d.name, value: d.value + (d.important ? ' !important' : ''), status: won ? 'won' : 'overridden', ...(won ? {} : { winner: win ? win.rule.selector : null }) };
    }),
  }));
  // cascade order: strongest rule first (by its max cascade key)
  annotated.sort((x, y) => (greater(y.maxKey, x.maxKey) ? 1 : greater(x.maxKey, y.maxKey) ? -1 : 0));
  for (const r of annotated) delete r.maxKey;
  return { annotated, winners };
}

/** Which ancestor supplied each inherited property's value. */
function inheritedChain(matched, ownWins) {
  const out = [];
  const inh = matched.inherited || [];
  for (const prop of INHERIT_PROPS) {
    if (ownWins.has(prop)) continue; // the element sets it directly — not inherited
    for (let depth = 0; depth < inh.length; depth++) {
      const entry = inh[depth];
      const rulesHere = buildRules({ inlineStyle: entry.inlineStyle, matchedCSSRules: entry.matchedCSSRules });
      const { winners } = resolveCascade(rulesHere);
      const w = winners.get(prop);
      if (w) { out.push({ property: prop, value: w.decl.value, from: w.rule.selector, source: w.rule.source, ancestorDepth: depth + 1 }); break; }
    }
  }
  return out;
}

const CONTRAST_FN = `function(){
  function pc(str){var m=String(str).match(/rgba?\\(([^)]+)\\)/);if(!m)return[0,0,0,0];var p=m[1].split(',').map(function(s){return parseFloat(s);});return[p[0]||0,p[1]||0,p[2]||0,p[3]===undefined?1:p[3]];}
  function over(t,b){var a=t[3];return[t[0]*a+b[0]*(1-a),t[1]*a+b[1]*(1-a),t[2]*a+b[2]*(1-a),1];}
  function lum(c){var s=[c[0],c[1],c[2]].map(function(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*s[0]+0.7152*s[1]+0.0722*s[2];}
  var el=this,cs=getComputedStyle(el),fg=pc(cs.color),bg=[255,255,255,1],chain=[],n=el;
  while(n){chain.push(pc(getComputedStyle(n).backgroundColor));n=n.parentElement;}
  for(var i=chain.length-1;i>=0;i--){if(chain[i][3]>0)bg=over(chain[i],bg);}
  if(fg[3]<1)fg=over(fg,bg);
  var L1=lum(fg),L2=lum(bg),hi=Math.max(L1,L2),lo=Math.min(L1,L2),ratio=(hi+0.05)/(lo+0.05);
  return {fg:'rgb('+fg.slice(0,3).map(Math.round).join(',')+')',bg:'rgb('+bg.slice(0,3).map(Math.round).join(',')+')',ratio:Math.round(ratio*100)/100};
}`;

async function ensureCss(s) {
  if (s._cssReady) return;
  await s.cdp.send('DOM.enable').catch(() => {});
  await s.cdp.send('CSS.enable').catch(() => {});
  s._cssReady = true;
}

async function resolveNodeId(s, body) {
  const { cdp } = s;
  if (body.ref) {
    const reg = s.observe && s.observe.registry.get(body.ref);
    if (!reg) throw gbErr(CODES.STALE_REF, `ref '${body.ref}' is unknown`, { field: 'ref', correction_hint: 'observe first' });
    const r = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [reg.backendNodeId] }).catch(() => null);
    const nodeId = r && r.nodeIds && r.nodeIds[0];
    if (!nodeId) throw gbErr(CODES.STALE_REF, `ref '${body.ref}' no longer resolves`, { field: 'ref', correction_hint: 're-observe' });
    return nodeId;
  }
  const selector = body.selector;
  if (!selector) throw gbErr(CODES.NO_TARGET, 'style needs `selector` or `ref`', { field: 'selector' });
  const doc = await cdp.send('DOM.getDocument', { depth: 0 });
  let q;
  try { q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector }); }
  catch { throw gbErr(CODES.BAD_REQUEST, `invalid selector '${selector}'`, { field: 'selector' }); }
  if (!q || !q.nodeId) throw gbErr(CODES.NO_TARGET, `selector '${selector}' matched nothing`, { field: 'selector', correction_hint: 'check the selector' });
  return q.nodeId;
}

async function styleFor(s, body) {
  await ensureCss(s);
  const { cdp } = s;
  const nodeId = await resolveNodeId(s, body);

  const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
  const computedArr = (await cdp.send('CSS.getComputedStyleForNode', { nodeId }).catch(() => ({ computedStyle: [] }))).computedStyle || [];
  const computedMap = {};
  for (const p of computedArr) computedMap[p.name] = p.value;

  const rules = buildRules(matched);
  const { annotated, winners } = resolveCascade(rules);

  // computed key props: the fixed set + anything a matched author rule actually set
  const setByRules = new Set(); for (const r of rules) for (const d of r.decls) setByRules.add(d.name);
  const keyNames = [...new Set([...KEY_PROPS, ...[...setByRules].filter((n) => computedMap[n] !== undefined)])];
  const computed = {}; for (const n of keyNames) if (computedMap[n] !== undefined) computed[n] = computedMap[n];

  // contrast (fg vs composited bg walk)
  let contrast = null;
  try {
    const obj = await cdp.send('DOM.resolveNode', { nodeId });
    const oid = obj && obj.object && obj.object.objectId;
    if (oid) {
      const r = await cdp.send('Runtime.callFunctionOn', { objectId: oid, functionDeclaration: CONTRAST_FN, returnByValue: true });
      const v = r.result && r.result.value;
      if (v) contrast = { fg: v.fg, bg: v.bg, ratio: v.ratio, wcagAA: v.ratio >= 4.5, wcagAAA: v.ratio >= 7 };
      cdp.send('Runtime.releaseObject', { objectId: oid }).catch(() => {});
    }
  } catch { /* contrast is best-effort */ }

  const inherited = inheritedChain(matched, winners);

  const n = (s._styleN = (s._styleN || 0) + 1);
  const full = { target: body.ref ? { ref: body.ref } : { selector: body.selector }, url: s.page.url(), computed, contrast, cascade: annotated, inherited };
  const report = s.journal.alloc('reports', `style-${n}.json`);
  try { fs.writeFileSync(report, JSON.stringify(full, null, 2)); } catch { /* disk */ }
  s.journal.log('command', { op: 'style', target: body.selector || body.ref, report });

  // compact: top 8 rules, ≤10 props each
  const cascade = annotated.slice(0, 8).map((r) => ({ selector: r.selector, source: r.source, specificity: r.specificity, properties: r.properties.slice(0, 10) }));
  return { ok: true, target: full.target, computed, contrast, cascade, inherited, rules: annotated.length, report };
}

/** Route POST /sessions/:name/style {selector|ref}. Needs the live page → serial queue, refused while paused. */
export async function handleStyle(mgr, name, body = {}) {
  const s = mgr._get(name); // throws NO_SESSION
  if (s.debug && s.debug.paused) {
    throw gbErr(CODES.PAUSED, 'cannot inspect styles while paused at a breakpoint', { field: 'op', correction_hint: 'resume first (debug resume)' });
  }
  return mgr.runQueued(s, () => styleFor(s, body));
}
