// Distilled hybrid DOM+AX snapshot with numbered refs (arch §3, research 06 §8, spike 3).
// The raw AXTree of a production page is ~95k tokens; distilled it is ~1.4k. We merge the
// browser's accessibility tree with a DOM sweep for interactive elements so that un-ARIA'd
// nodes (a bare <div onclick> — the modal case for freshly-written UI) are FLAGGED, not hidden:
// a pure-AX tool goes blind on exactly the newest, buggiest part of the page. Refs (e1,e2,…)
// back onto backendNodeIds and carry a snapshot version for staleness.
import fs from 'node:fs';
import { CODES, gbErr } from '../protocol.mjs';
import { installObserver } from './settle.mjs';

const SEL = 'a,button,input,select,textarea,[onclick],[role],[tabindex]';
// Runs on the interactive-element array: returns aligned by-value descriptors (backendNodeIds
// come separately via getProperties+describeNode, matched by index).
const DESC_FN = `function(){return Array.prototype.map.call(this,function(el){return {tag:el.tagName.toLowerCase(),role:el.getAttribute('role'),type:el.getAttribute('type'),id:el.id||null,testid:el.getAttribute('data-testid')||null,name:(el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('alt')||'').trim().slice(0,80),text:(el.innerText||el.value||'').replace(/\\s+/g,' ').trim().slice(0,80),disabled:el.disabled===true||el.getAttribute('aria-disabled')==='true'};});}`;

const GENERIC = new Set(['generic', 'GenericContainer', 'none', 'presentation', undefined, null, '']);
const isGeneric = (node) => GENERIC.has(node.role?.value);

function axProps(node) {
  const m = {};
  for (const p of node.properties || []) m[p.name] = p.value?.value;
  return m;
}

function keptFrom(node, depth, hit) {
  const pr = axProps(node);
  const generic = isGeneric(node);
  const nm = (node.name?.value || '').trim();
  const k = {
    ref: '',
    backendNodeId: node.backendDOMNodeId,
    role: hit && generic ? hit.role || hit.tag : node.role?.value || 'generic',
    name: nm.slice(0, 80),
    depth,
    flags: [],
    _text: [],
  };
  if (hit && generic) {
    k.flags.push('no-ax'); // DOM-interactive but AX-invisible (no role/name) — surfaced, not dropped
    if (!k.name && hit.text) k.name = hit.text.slice(0, 80);
  }
  const val = node.value?.value;
  if (val != null && val !== '') k.value = String(val).slice(0, 80);
  if (pr.disabled === true || hit?.disabled) k.disabled = true;
  if (pr.checked != null) k.checked = pr.checked;
  if (pr.expanded != null) k.expanded = pr.expanded;
  return k;
}

/**
 * PURE distiller — no browser. Given raw AX nodes + a DOM-interactive list (+ optional scope
 * root backendNodeId), produce ordered kept nodes with refs. StaticText/InlineTextBox content
 * is folded into the nearest kept ancestor's `text` (never lost). Interactive elements that AX
 * dropped (generic/ignored) are kept in-place with a `no-ax` flag; any not present in the AX
 * tree at all are appended. Exported for unit-testing without a running browser.
 */
export function distill({ axNodes, interactive = [], rootBackend = null }) {
  const byId = new Map(axNodes.map((n) => [n.nodeId, n]));
  const interByBackend = new Map();
  for (const it of interactive) if (it.backendNodeId != null) interByBackend.set(it.backendNodeId, it);
  const placed = new Set();
  const kept = [];

  let rootIds;
  if (rootBackend != null) {
    const rn = axNodes.find((n) => n.backendDOMNodeId === rootBackend);
    rootIds = rn ? [rn.nodeId] : [];
  } else {
    rootIds = axNodes.filter((n) => !n.parentId).map((n) => n.nodeId);
    if (!rootIds.length && axNodes.length) rootIds = [axNodes[0].nodeId];
  }

  const visit = (node, depth, textOwner) => {
    const role = node.role?.value;
    const isText = role === 'StaticText' || role === 'InlineTextBox';
    const nm = (node.name?.value || '').trim();
    // Fold StaticText only (InlineTextBox is its duplicate child) into the nearest kept ancestor.
    if (role === 'StaticText' && !node.ignored && nm && textOwner) textOwner._text.push(nm);
    const hit = interByBackend.get(node.backendDOMNodeId);
    const dropGeneric = isGeneric(node) && !nm && !hit;
    let owner = textOwner;
    let d = depth;
    if (!node.ignored && !isText && !dropGeneric) {
      const k = keptFrom(node, depth, hit);
      kept.push(k);
      if (hit) placed.add(node.backendDOMNodeId);
      owner = k;
      d = depth + 1;
    }
    for (const cid of node.childIds || []) {
      const c = byId.get(cid);
      if (c) visit(c, d, owner);
    }
  };
  for (const id of rootIds) {
    const n = byId.get(id);
    if (n) visit(n, 0, null);
  }

  // interactive elements AX never surfaced (aria-hidden subtree, detached from the walked root)
  if (rootBackend == null) {
    for (const it of interactive) {
      if (it.backendNodeId == null || placed.has(it.backendNodeId)) continue;
      kept.push({
        ref: '', backendNodeId: it.backendNodeId, role: it.role || it.tag,
        name: (it.name || it.text || '').slice(0, 80), depth: 0, flags: ['no-ax'], _text: [],
        ...(it.disabled ? { disabled: true } : {}),
      });
    }
  }

  kept.forEach((k, i) => {
    k.ref = 'e' + (i + 1);
    // A node's accessible name already conveys its text; only surface folded text for UNNAMED
    // structural nodes (main, paragraph, un-ARIA'd div) — this halves token cost on link/button grids.
    const t = k._text.join(' ').replace(/\s+/g, ' ').trim();
    if (t && !k.name) k.text = t.slice(0, 80);
    delete k._text;
  });
  return { nodes: kept };
}

/** PURE render — compact indented tree, playwright-mcp-snapshot style. */
export function renderTree(nodes) {
  const lines = [];
  for (const n of nodes) {
    let s = '  '.repeat(n.depth) + n.ref + ' ' + n.role;
    if (n.name) s += ' ' + JSON.stringify(n.name);
    const b = [];
    if (n.text) b.push('text=' + JSON.stringify(n.text));
    if (n.value != null) b.push('value=' + JSON.stringify(n.value));
    if (n.disabled) b.push('disabled');
    if (n.checked != null) b.push('checked=' + n.checked);
    if (n.expanded != null) b.push('expanded=' + n.expanded);
    for (const f of n.flags || []) b.push('[' + f + ']');
    if (b.length) s += '  ' + b.join(' ');
    lines.push(s);
  }
  return lines.join('\n');
}

// ---- browser-wired glue -----------------------------------------------------

async function ensureDomains(session) {
  if (session._domains) return;
  await session.cdp.send('DOM.enable').catch(() => {});
  await session.cdp.send('Accessibility.enable').catch(() => {});
  session._domains = true;
}

async function backendForSelector(cdp, selector) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  if (!result.objectId) return null;
  try {
    const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId });
    return node.backendNodeId;
  } finally {
    cdp.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
  }
}

/** DOM sweep for interactive elements + their backendNodeIds (visible-only, to keep noise down). */
async function queryInteractive(cdp) {
  const expr = `Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(SEL)})).filter(function(el){var r=el.getBoundingClientRect();if(!(r.width||r.height))return false;try{if(el.checkVisibility&&el.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})===false)return false;}catch(e){}return true;})`;
  const { result } = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: false });
  if (!result.objectId) return [];
  const out = [];
  try {
    const desc = await cdp.send('Runtime.callFunctionOn', {
      objectId: result.objectId, returnByValue: true, functionDeclaration: DESC_FN,
    });
    const arr = desc.result?.value || [];
    const props = await cdp.send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
    for (const p of props.result) {
      if (!/^\d+$/.test(p.name)) continue;
      const oid = p.value?.objectId;
      if (!oid || !arr[+p.name]) continue;
      try {
        const { node } = await cdp.send('DOM.describeNode', { objectId: oid });
        arr[+p.name].backendNodeId = node.backendNodeId;
      } catch { /* node gone mid-sweep */ }
    }
    for (const it of arr) if (it && it.backendNodeId != null) out.push(it);
  } finally {
    cdp.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
  }
  return out;
}

/**
 * Take a snapshot: bump the session's observe version, rebuild the ref→backendNodeId registry,
 * re-arm the mutation observer (fresh baseline), write the raw AXTree to reports/, and return the
 * text tree + JSON variant + pagination cursor + the AX artifact path. `opts`: {selector?, limit?, cursor?}.
 */
export async function observe(session, opts = {}) {
  await ensureDomains(session);
  const { cdp, page } = session;

  let rootBackend = null;
  if (opts.selector) {
    rootBackend = await backendForSelector(cdp, opts.selector);
    if (rootBackend == null)
      throw gbErr(CODES.NO_TARGET, `selector '${opts.selector}' matched nothing to scope to`, { field: 'selector' });
  }
  const ax = await cdp.send('Accessibility.getFullAXTree');
  const interactive = await queryInteractive(cdp);
  const { nodes } = distill({ axNodes: ax.nodes, interactive, rootBackend });

  session.observe.version += 1;
  session.observe.navSeqAt = session.observe.navSeq;
  const reg = new Map();
  for (const n of nodes) reg.set(n.ref, { backendNodeId: n.backendNodeId, version: session.observe.version });
  session.observe.registry = reg;
  await installObserver(page);

  const limit = opts.limit > 0 ? Math.min(opts.limit, 1000) : null;
  const cursor = opts.cursor > 0 ? opts.cursor : 0;
  const view = limit ? nodes.slice(cursor, cursor + limit) : nodes;
  const nextCursor = limit && cursor + limit < nodes.length ? cursor + limit : null;

  const axPath = session.journal.alloc('reports', `axtree-v${session.observe.version}-${Date.now()}.json`);
  try { fs.writeFileSync(axPath, JSON.stringify(ax.nodes)); } catch { /* disk full etc. — snapshot still returns */ }
  session.journal.log('command', { op: 'observe', version: session.observe.version, nodes: nodes.length, shown: view.length, ax: axPath });

  return {
    ok: true,
    version: session.observe.version,
    url: page.url(),
    count: nodes.length,
    shown: view.length,
    cursor,
    nextCursor,
    text: renderTree(view),
    nodes: view.map(({ backendNodeId, ...rest }) => rest),
    axPath,
  };
}
