// Actions + grounding (arch §3/§8). Every verb runs through the session's serial queue, resolves
// its target one of five ways (selector | testid | role+name | text | ref), performs a Playwright
// locator action (auto-wait actionability + a bounded timeout), settles, and returns a DELTA:
// what changed, not the whole page. Selector-first grounding is the headline edge — a coding
// agent wrote the code, so its own selector is a valid target with no prior observe call.
// Refs are the other path: registry → backendNodeId → a computed unique CSS path → locator (a
// no-mutation route, so tagging the element never pollutes the mutation observer). A pending
// native dialog is surfaced in every response and NEVER hangs the call (playwright-mcp #595).
import { CODES, gbErr } from '../protocol.mjs';
import { observe } from './observe.mjs';
import { verify, read } from './verify.mjs';
import { settle, ensureObserver, readMut, isDirty } from './settle.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const ALL_VERBS = new Set(['goto', 'click', 'dblclick', 'hover', 'type', 'press', 'scroll', 'drag', 'upload', 'select']);
const NEEDS_TARGET = new Set(['click', 'dblclick', 'hover', 'type', 'upload', 'select']);

// Reads a backendNode's unique CSS path WITHOUT mutating it (no temp attribute → no observer noise).
const PATH_FN = `function(){function esc(s){return (window.CSS&&CSS.escape)?CSS.escape(s):s;}var el=this,parts=[];while(el&&el.nodeType===1&&el!==document.documentElement){var sel=el.tagName.toLowerCase();var p=el.parentElement;if(p){var same=Array.prototype.filter.call(p.children,function(c){return c.tagName===el.tagName;});if(same.length>1)sel+=':nth-of-type('+(same.indexOf(el)+1)+')';}parts.unshift(sel);el=el.parentElement;}return parts.length?('html > '+parts.join(' > ')):'html';}`;

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
    const reasons = msg.match(/- ([^\n]+)/g) || [];
    const actionability = reasons.length ? reasons[reasons.length - 1].replace(/^- /, '') : undefined;
    return { code: CODES.ACT_TIMEOUT, message: `action timed out: ${actionability || 'actionability check unmet'}`, actionability, blockedBy };
  }
  if (/strict mode violation/i.test(msg))
    return { code: CODES.NO_TARGET, message: 'target matched multiple elements (be more specific)', actionability: 'strict mode violation' };
  if (/resolved to 0 elements|waiting for locator|no element/i.test(msg))
    return { code: CODES.NO_TARGET, message: 'target not found', actionability: first };
  return { code: CODES.ACT_TIMEOUT, message: first, blockedBy };
}

// ---- performing actions -----------------------------------------------------

async function doScroll(session, body) {
  const { page } = session;
  if (body.by != null) return page.evaluate((y) => window.scrollBy(0, y), Number(body.by));
  const to = body.to;
  if (to === 'top') return page.evaluate(() => window.scrollTo(0, 0));
  if (to === 'bottom') return page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  if (body.ref || (to && typeof to === 'object') || typeof to === 'string') {
    const target = body.ref ? { ref: body.ref } : typeof to === 'string' ? { selector: to } : to;
    const loc = await resolveTarget(session, target);
    return loc.scrollIntoViewIfNeeded({ timeout: 5000 });
  }
  throw gbErr(CODES.BAD_REQUEST, 'scroll needs `to` (top|bottom|selector|ref) or `by` (px)', { field: 'to' });
}

async function rawPerform(session, verb, body, target) {
  const to = body.timeoutMs || 5000;
  switch (verb) {
    case 'goto': {
      if (!body.url) throw gbErr(CODES.BAD_REQUEST, 'goto needs a url', { field: 'url' });
      return session.page.goto(body.url, { timeout: body.timeoutMs || 30000, waitUntil: 'domcontentloaded' });
    }
    case 'click': return target.click({ timeout: to });
    case 'dblclick': return target.dblclick({ timeout: to });
    case 'hover': return target.hover({ timeout: to });
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
  const wrapped = rawPerform(session, verb, body, target).then(() => { done = true; }, (e) => { done = true; err = e; });
  await Promise.race([wrapped, dlg]);
  if (session.pendingDialog && !done) {
    session._inflight = wrapped; // the action is blocked on the dialog; the responder will await it
    return;
  }
  await wrapped;
  if (err) throw err;
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
  try {
    await perform(session, verb, body, target);
  } catch (e) {
    if (!session.pendingDialog) {
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
  if (session.pendingDialog) delta.dialog = { type: session.pendingDialog.type, message: session.pendingDialog.message };
  session.journal.log('command', { op: verb, url: endUrl, settled: delta.settled, mutations: delta.mutations });
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
export async function handleAction(mgr, name, verb, body = {}) {
  const s = mgr._get(name); // throws NO_SESSION
  if (verb === 'observe') return mgr.runQueued(s, () => observe(s, body));
  if (verb === 'verify') return mgr.runQueued(s, () => verify(s, body));
  if (verb === 'read') return mgr.runQueued(s, () => read(s, body));
  if (verb === 'dialog') return mgr.runQueued(s, () => respondDialog(s, body));
  if (verb === 'settle') return mgr.runQueued(s, async () => ({ ok: true, ...(await settle(s, body)) }));
  if (ALL_VERBS.has(verb)) return mgr.runQueued(s, () => runOne(s, verb, body));
  throw gbErr(CODES.BAD_REQUEST, `unknown action '${verb}'`, { field: 'verb', valid_values: [...ALL_VERBS, 'observe', 'verify', 'read', 'dialog'] });
}
