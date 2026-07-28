// Actions + grounding (arch §3/§8). Every verb runs through the session's serial queue, resolves
// its target one of five ways (selector | testid | role+name | text | ref), performs a Playwright
// locator action (auto-wait actionability + a bounded timeout), settles, and returns a DELTA:
// what changed, not the whole page. Selector-first grounding is the headline edge — a coding
// agent wrote the code, so its own selector is a valid target with no prior observe call.
// Refs are the other path: registry → backendNodeId → a computed unique CSS path → locator (a
// no-mutation route, so tagging the element never pollutes the mutation observer). A pending
// native dialog is surfaced in every response and NEVER hangs the call (playwright-mcp #595).
import { CODES, PATHS, gbErr } from '../protocol.mjs';
import { exportReport, latestReport } from '../report-html.mjs';
import { observe } from './observe.mjs';
import { verify, read } from './verify.mjs';
import { evalExpression, screenshotAction, waitFor, setViewport } from './extras.mjs';
import { settle, ensureObserver, readMut, isDirty } from './settle.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const ALL_VERBS = new Set(['goto', 'click', 'dblclick', 'hover', 'type', 'press', 'scroll', 'drag', 'upload', 'select']);
const NEEDS_TARGET = new Set(['click', 'dblclick', 'hover', 'type', 'upload', 'select']);

// Reads a backendNode's unique CSS path WITHOUT mutating it (no temp attribute → no observer noise).
const PATH_FN = `function(){function esc(s){return (window.CSS&&CSS.escape)?CSS.escape(s):s;}var el=this,parts=[];while(el&&el.nodeType===1&&el!==document.documentElement){var sel=el.tagName.toLowerCase();var p=el.parentElement;if(p){var same=Array.prototype.filter.call(p.children,function(c){return c.tagName===el.tagName;});if(same.length>1)sel+=':nth-of-type('+(same.indexOf(el)+1)+')';}parts.unshift(sel);el=el.parentElement;}return parts.length?('html > '+parts.join(' > ')):'html';}`;

// D1 — the hit-point probe. Playwright's own actionability check runs AFTER it scrolls the target
// into view, so a control buried under a fixed overlay at the CURRENT scroll position can be
// scrolled out from under it and clicked "successfully" — the tool then reports a click no real
// pointer could have made, contradicting `verify`, which flagged the same element as occluded.
// This probe asks the same question verify's layout audit asks, at the position the user is looking
// at, with the same rule (self / ancestor / descendant hits are fine; anything else is an occluder),
// and it pierces open shadow roots. Returns null when there is nothing to say (off-screen, zero-size,
// not covered) so ordinary clicks pay one cheap round-trip and nothing else.
const hitProbe = (el) => {
  const describe = (n) => {
    if (!n || !n.tagName) return '?';
    let s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    else {
      let c = n.className; if (c && c.baseVal !== undefined) c = c.baseVal;
      if (c && typeof c === 'string' && c.trim()) s += '.' + c.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return s.slice(0, 90);
  };
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;                                // zero-size: Playwright's own checks speak
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null; // off-screen: scrolling is legitimate
  let hit = null;
  try { hit = document.elementFromPoint(cx, cy); } catch { return null; }
  if (!hit) return null;
  for (let g = 0; g < 10 && hit.shadowRoot; g++) {
    const inner = hit.shadowRoot.elementFromPoint(cx, cy);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (hit === el || el.contains(hit) || hit.contains(el)) return null;
  let modal = null;
  for (let n = hit; n; n = n.parentElement) {
    if (n.getAttribute && (n.getAttribute('aria-modal') === 'true' || n.getAttribute('role') === 'dialog' || (n.tagName === 'DIALOG' && n.hasAttribute('open')))) { modal = n; break; }
  }
  return { by: describe(hit), point: [Math.round(cx), Math.round(cy)], modal: modal ? describe(modal) : null };
};

/**
 * Refuse a click a real pointer cannot make. Returns the occluder record when the target's hit
 * point belongs to some other element (so the caller can stamp `occludedBy` on a forced click);
 * throws a structured ACT_OCCLUDED when the caller did NOT opt in with force.
 */
async function checkHitPoint(session, target, force, timeoutMs) {
  let probe = null;
  try { probe = await target.evaluate(hitProbe, undefined, { timeout: timeoutMs }); }
  catch { return null; } // element gone/unstable — Playwright's own actionability owns that verdict
  if (!probe) return null;
  if (force) return probe;
  const where = probe.modal ? ` (inside the open modal ${probe.modal})` : '';
  throw gbErr(CODES.ACT_OCCLUDED, `target is covered at its click point (${probe.point.join(',')}) by ${probe.by}${where} — a real pointer would hit that instead`, {
    field: 'target',
    occludedBy: probe.by,
    ...(probe.modal ? { modal: probe.modal } : {}),
    // force:true dispatches the click at that point regardless — which means the OCCLUDER receives
    // it, exactly as a real user's click would. Say so rather than implying the target gets it.
    correction_hint: probe.modal
      ? `close the modal ${probe.modal} first, or pass force:true (--force) to dispatch the click at that point anyway (recorded as forced:true — ${probe.by} is what will receive it)`
      : `dismiss or fix the z-order of ${probe.by}, scroll the target clear of it, or pass force:true (--force) to dispatch the click at that point anyway (recorded as forced:true — ${probe.by} is what will receive it)`,
  });
}

// ---- target resolution ------------------------------------------------------

async function refToLocator(session, ref) {
  const reg = session.observe.registry.get(ref);
  const stale = (msg) => gbErr(CODES.STALE_REF, msg, { field: 'ref', correction_hint: 're-observe to get fresh refs' });
  if (!reg) throw stale(`ref '${ref}' is unknown — it was never observed, or a newer observe replaced it`);
  if (reg.version !== session.observe.version) throw stale(`ref '${ref}' is from an older snapshot`);
  if (session.observe.navSeqAt !== session.observe.navSeq) throw stale(`ref '${ref}' predates a navigation`);
  if (await isDirty(session)) throw stale(`ref '${ref}' is stale — the DOM mutated since the last observe`);

  const { cdp, page } = session;
  let obj;
  try { obj = (await cdp.send('DOM.resolveNode', { backendNodeId: reg.backendNodeId })).object; }
  catch { throw stale(`ref '${ref}' no longer resolves to a live node`); }
  if (!obj?.objectId) throw stale(`ref '${ref}' no longer resolves to a live node`);
  let css;
  try {
    const r = await cdp.send('Runtime.callFunctionOn', { objectId: obj.objectId, functionDeclaration: PATH_FN, returnByValue: true });
    css = r.result?.value;
  } finally {
    cdp.send('Runtime.releaseObject', { objectId: obj.objectId }).catch(() => {});
  }
  if (!css) throw stale(`ref '${ref}' could not be located`);
  return page.locator(css).first();
}

async function resolveTarget(session, t) {
  if (!t || typeof t !== 'object')
    throw gbErr(CODES.NO_TARGET, 'no target', { field: 'target', correction_hint: 'provide selector, testid, role+name, text, or ref' });
  if (t.ref) return refToLocator(session, t.ref);
  const { page } = session;
  if (t.selector) return page.locator(t.selector).first();
  if (t.testid) return page.getByTestId(t.testid).first();
  if (t.role) return page.getByRole(t.role, t.name ? { name: t.name } : {}).first();
  if (t.text) return page.getByText(t.text).first();
  throw gbErr(CODES.NO_TARGET, 'unrecognized target', { field: 'target', correction_hint: 'one of: selector, testid, role(+name), text, ref' });
}

// ---- Playwright error → structured error ------------------------------------

function parsePwError(e) {
  const msg = (e && e.message) || String(e);
  const first = msg.split('\n')[0];
  const im = msg.match(/<([^>]{1,120}?)>\s*(?:from[\s\S]*?)?intercepts pointer events/i);
  const blockedBy = im ? '<' + im[1].trim() + '>' : undefined;
  if (/Timeout .*exceeded/i.test(msg)) {
    // Playwright's call log ends with bookkeeping lines ("- waiting 500ms", "- retrying click…").
    // Those are not a diagnosis; hunt for the line that actually names the failed check, so the
    // error reads "…intercepts pointer events" instead of the useless "waiting 500ms".
    const reasons = (msg.match(/- ([^\n]+)/g) || []).map((s) => s.replace(/^- /, '').trim());
    const real = reasons.filter((r) => !/^waiting\b/i.test(r) && !/^retrying\b/i.test(r) && !/^attempting\b/i.test(r) && !/^\d+ ×/.test(r));
    const named = [...real].reverse().find((r) => /intercept|not visible|not stable|not enabled|disabled|not editable|outside of the viewport|resolved to/i.test(r));
    const actionability = named || real[real.length - 1] || reasons[reasons.length - 1];
    return { code: CODES.ACT_TIMEOUT, message: `action timed out: ${actionability || 'actionability check unmet'}`, actionability, blockedBy };
  }
  if (/strict mode violation/i.test(msg))
    return { code: CODES.NO_TARGET, message: 'target matched multiple elements (be more specific)', actionability: 'strict mode violation' };
  if (/resolved to 0 elements|waiting for locator|no element/i.test(msg))
    return { code: CODES.NO_TARGET, message: 'target not found', actionability: first };
  return { code: CODES.ACT_TIMEOUT, message: first, blockedBy };
}

// ---- performing actions -----------------------------------------------------

// `scroll --to` on a target that is already fully on screen is a no-op inside Playwright. That is
// correct, but "ok — 0 mut" reads as "scrolled" — so say which one happened (dogfood observation).
const isInView = (el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
};

async function doScroll(session, body) {
  const { page } = session;
  if (body.by != null) return page.evaluate((y) => window.scrollBy(0, y), Number(body.by));
  const to = body.to;
  if (to === 'top') return page.evaluate(() => window.scrollTo(0, 0));
  if (to === 'bottom') return page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  if (body.ref || (to && typeof to === 'object') || typeof to === 'string') {
    const target = body.ref ? { ref: body.ref } : typeof to === 'string' ? { selector: to } : to;
    const loc = await resolveTarget(session, target);
    const already = await loc.evaluate(isInView, undefined, { timeout: 5000 }).catch(() => false);
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
    return { gbNote: already ? 'already in view (no scroll needed)' : 'scrolled into view' };
  }
  throw gbErr(CODES.BAD_REQUEST, 'scroll needs `to` (top|bottom|selector|ref) or `by` (px)', { field: 'to' });
}

async function rawPerform(session, verb, body, target) {
  const to = body.timeoutMs || 5000;
  const force = !!body.force;
  switch (verb) {
    case 'goto': {
      if (!body.url) throw gbErr(CODES.BAD_REQUEST, 'goto needs a url', { field: 'url' });
      return session.page.goto(body.url, { timeout: body.timeoutMs || 30000, waitUntil: 'domcontentloaded' });
    }
    case 'click': {
      const occ = await checkHitPoint(session, target, force, to); // throws ACT_OCCLUDED unless forced
      await target.click({ timeout: to, ...(force ? { force: true } : {}) });
      return { gbForced: force, gbOccludedBy: occ ? occ.by : null };
    }
    case 'dblclick': {
      const occ = await checkHitPoint(session, target, force, to);
      await target.dblclick({ timeout: to, ...(force ? { force: true } : {}) });
      return { gbForced: force, gbOccludedBy: occ ? occ.by : null };
    }
    case 'hover': return target.hover({ timeout: to, ...(force ? { force: true } : {}) });
    case 'type':
      await target.fill(body.text ?? '', { timeout: to });
      if (body.submit) await target.press('Enter', { timeout: to });
      return;
    case 'press': {
      if (!body.key) throw gbErr(CODES.BAD_REQUEST, 'press needs a key', { field: 'key' });
      if (target) return target.press(body.key, { timeout: to });
      return session.page.keyboard.press(body.key);
    }
    case 'scroll': return doScroll(session, body);
    case 'drag': {
      const from = await resolveTarget(session, body.from);
      const dst = await resolveTarget(session, body.to);
      return from.dragTo(dst, { timeout: to });
    }
    case 'upload': return target.setInputFiles([].concat(body.files || []), { timeout: to });
    case 'select': return target.selectOption([].concat(body.values || []), { timeout: to });
    default: throw gbErr(CODES.BAD_REQUEST, `unknown action '${verb}'`, { field: 'verb' });
  }
}

// A native dialog stalls the triggering Playwright action indefinitely. Rather than hang, we
// register a waiter before acting and race it: if the dialog fires, we return the delta (dialog
// surfaced) and stash the still-pending action on the session for the dialog responder to await.
function dialogSignal(session) {
  if (session.pendingDialog) return Promise.resolve();
  return new Promise((res) => session._dialogWaiters.push(res));
}

async function perform(session, verb, body, target) {
  const dlg = dialogSignal(session);
  let done = false;
  let err = null;
  let value = null;
  const wrapped = rawPerform(session, verb, body, target).then((v) => { done = true; value = v; }, (e) => { done = true; err = e; });
  await Promise.race([wrapped, dlg]);
  if (session.pendingDialog && !done) {
    session._inflight = wrapped; // the action is blocked on the dialog; the responder will await it
    return null;
  }
  await wrapped;
  if (err) throw err;
  return value;
}

// ---- the one action runner (delta builder) ----------------------------------

async function runOne(session, verb, body) {
  if (session.pendingDialog)
    throw gbErr(CODES.DIALOG_PENDING, 'a native dialog is awaiting a response', {
      field: 'dialog', correction_hint: 'respond with the dialog action (accept|dismiss) first',
      valid_values: ['accept', 'dismiss'],
    });

  const t0 = Date.now();
  const mark = session.console.mark();
  const startUrl = session.page.url();
  await ensureObserver(session);
  const mutBefore = await readMut(session);

  const target = NEEDS_TARGET.has(verb) ? await resolveTarget(session, body) : null; // throws STALE_REF/NO_TARGET
  let performed = null;
  try {
    performed = await perform(session, verb, body, target);
  } catch (e) {
    if (!session.pendingDialog) {
      if (e && e.gb) throw e; // already structured (ACT_OCCLUDED / BAD_REQUEST) — don't re-wrap
      const pe = parsePwError(e);
      throw gbErr(pe.code, pe.message, {
        field: 'target',
        correction_hint: pe.code === CODES.STALE_REF ? 're-observe' : 'check the target and its actionability',
        ...(pe.blockedBy ? { blockedBy: pe.blockedBy } : {}),
        ...(pe.actionability ? { actionability: pe.actionability } : {}),
      });
    }
    // else: the action is blocked on a dialog — fall through and report it in the delta
  }

  const settleRes = session.pendingDialog ? { settled: true, why: ['dialog'] } : await settle(session, { navigation: verb === 'goto' });
  const endUrl = session.page.url();
  const mutAfter = session.pendingDialog ? mutBefore : await readMut(session);

  const delta = {
    ok: true,
    settled: settleRes.settled,
    url: endUrl,
    urlChanged: endUrl !== startUrl,
    console: session.console.since(mark, 10),
    mutations: Math.max(0, mutAfter - mutBefore),
    tookMs: Date.now() - t0,
  };
  if (settleRes.why?.length) delta.settleWhy = settleRes.why;
  // A forced click is stamped INTO the delta (with what was in the way, when we know it): the
  // record must never let a forced interaction read like an ordinary one (defect D1).
  if (performed && performed.gbForced) {
    delta.forced = true;
    if (performed.gbOccludedBy) delta.occludedBy = performed.gbOccludedBy;
  }
  if (performed && performed.gbNote) delta.note = performed.gbNote;
  if (session.pendingDialog) delta.dialog = { type: session.pendingDialog.type, message: session.pendingDialog.message };
  session.journal.log('command', { op: verb, url: endUrl, settled: delta.settled, mutations: delta.mutations, ...(delta.forced ? { forced: true } : {}) });
  return delta;
}

// ---- dialog responder -------------------------------------------------------

async function respondDialog(session, body) {
  if (!session.pendingDialog) throw gbErr(CODES.NO_DIALOG, 'no dialog is pending', { field: 'action' });
  const action = body.action || 'dismiss';
  const d = session._dialog;
  clearTimeout(session._dialogTimer);
  const was = session.pendingDialog;
  session.pendingDialog = null;
  session._dialog = null;
  try {
    if (action === 'accept') await d.accept(body.text);
    else await d.dismiss();
  } catch { /* dialog may already be gone (auto-dismissed on action timeout) */ }
  if (session._inflight) {
    try { await Promise.race([session._inflight, delay(5000)]); } catch { /* action error already surfaced */ }
    session._inflight = null;
  }
  const settleRes = await settle(session, { navigation: false });
  session.journal.log('command', { op: 'dialog', action, settled: settleRes.settled });
  return { ok: true, action, dialog: { type: was.type, message: was.message }, settled: settleRes.settled, url: session.page.url() };
}

// ---- daemon entrypoint ------------------------------------------------------

/** Route one POST /sessions/:name/<verb> — all run through the session's serial queue. */
/** Latest verify report for a session -> one self-contained HTML file. Disk only, no browser. */
function exportSession(name, body = {}) {
  const rp = latestReport(PATHS.sessions, name);
  if (!rp) {
    throw gbErr(CODES.BAD_REQUEST, `no verify report on disk for session '${name}'`, {
      field: 'session',
      correction_hint: 'run verify first — export reads the report verify writes',
    });
  }
  return { ...exportReport(rp, { out: body.out || null }), from: rp };
}

export async function handleAction(mgr, name, verb, body = {}) {
  const s = mgr._get(name); // throws NO_SESSION
  // M7: record an out-of-band event (a dev-server rebuild) in the session journal. Deliberately
  // ahead of the paused guard and outside the serial queue — journaling is a synchronous file
  // append that must land even while a breakpoint holds the queue, and it touches no page state.
  if (verb === 'journal') {
    const event = typeof body.event === 'string' && body.event ? body.event : 'note';
    s.journal.log(event, body.data && typeof body.data === 'object' ? body.data : {});
    return { ok: true, event };
  }
  // A paused session's queue is held by the parked (paused) action; a normal verb entering it now
  // would deadlock. Refuse fast with a structured PAUSED error (never hang) — the agent should
  // resume or use the debug tools, which run in a parallel lane.
  if (s.debug && s.debug.paused) {
    throw gbErr(CODES.PAUSED, `session '${name}' is paused at a breakpoint`, {
      field: 'session',
      correction_hint: 'resume (debug resume) or use debug tools (state/inspect/eval/step) while paused',
      valid_values: ['resume', 'step', 'inspect', 'eval', 'state'],
    });
  }
  if (verb === 'observe') return mgr.runQueued(s, () => observe(s, body));
  if (verb === 'verify') return mgr.runQueued(s, () => verify(s, body));
  if (verb === 'read') return mgr.runQueued(s, () => read(s, body));
  if (verb === 'dialog') return mgr.runQueued(s, () => respondDialog(s, body));
  if (verb === 'settle') return mgr.runQueued(s, async () => ({ ok: true, ...(await settle(s, body)) }));
  // M5 additions — all through the serial queue (so they interleave-safely with actions) and all
  // already refused above while paused.
  if (verb === 'eval') return mgr.runQueued(s, () => evalExpression(s, body));
  if (verb === 'screenshot') return mgr.runQueued(s, () => screenshotAction(s, body));
  if (verb === 'wait') return mgr.runQueued(s, () => waitFor(s, body));
  // D11 — resize an EXISTING session (theme×viewport matrices without re-opening + re-seeding).
  if (verb === 'viewport') return mgr.runQueued(s, () => setViewport(s, body));
  // Sandbox human channel: nobody can reach this box's loopback, so the report leaves as a file
  // instead of a live screencast. Not queued — it touches disk, never the browser, so it works
  // even while the session is paused at a breakpoint.
  if (verb === 'export') return exportSession(name, body);
  if (ALL_VERBS.has(verb)) return mgr.runQueued(s, () => runOne(s, verb, body));
  throw gbErr(CODES.BAD_REQUEST, `unknown action '${verb}'`, { field: 'verb', valid_values: [...ALL_VERBS, 'observe', 'verify', 'read', 'dialog', 'settle', 'eval', 'screenshot', 'wait', 'viewport', 'export', 'journal'] });
}
