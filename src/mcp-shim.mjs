#!/usr/bin/env node
// glassbox MCP shim — a stateless stdio JSON-RPC 2.0 server that proxies to the daemon's HTTP
// control plane. Hand-rolled (the protocol is small; no SDK). NEWLINE-DELIMITED framing (Claude
// Code's stdio transport), one message per line. The shim holds NO browser state — that lives in
// the daemon — so many shims (one per Claude session/subagent) are cheap and safe (research 04 §4).
//
// PROTOCOL PURITY: stdout carries ONLY JSON-RPC frames. Every diagnostic goes to stderr. One
// process.stdout.write per response, handled on a serial chain, so writes never interleave.
//
// TOKEN DISCIPLINE (research 04): 14 tools, no more (schema-discovery cost). Screenshots and other
// artifacts are returned as FILE PATHS, never inline base64 (Claude Code's 10-20x image tax).
// Structured daemon errors become isError text carrying {code, message, correction_hint,
// valid_values} — a stale ref / PAUSED / bad session is self-correcting from the message alone.
import { VERSION, ensureDaemon, daemonReq } from './protocol.mjs';

// One version for the whole product: protocol.mjs is the source, package.json and daemon.json agree
// (asserted in test/m8) — a client that sees serverInfo is seeing the daemon's real build.
const SERVER_INFO = { name: 'glassbox', version: VERSION };
const LATEST_PROTOCOL = '2025-06-18';
const KNOWN_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const MAX_TEXT = 20000; // per research 04 §4.6 — cap inline text, spill the rest to the artifact path

const logErr = (...a) => { try { process.stderr.write(a.map(String).join(' ') + '\n'); } catch { /* ignore */ } };

// ---- daemon connection (memoized, re-ensured on transport failure) ----------

let daemonPromise = null;
function getDaemon() {
  if (!daemonPromise) daemonPromise = ensureDaemon().catch((e) => { daemonPromise = null; throw e; });
  return daemonPromise;
}

/** One authed daemon round-trip, auto-starting/reconnecting the daemon. {status, body}. */
async function callDaemon(method, route, body, ms = 130000) {
  const d = await getDaemon();
  try {
    return await daemonReq(d, method, route, body, ms);
  } catch {
    daemonPromise = null; // daemon may have died/restarted — re-ensure once
    const d2 = await getDaemon();
    return await daemonReq(d2, method, route, body, ms);
  }
}

// ---- tool schemas (exactly 14; descriptions written FOR an agent) -----------

const S = {
  string: (description) => ({ type: 'string', description }),
  bool: (description) => ({ type: 'boolean', description }),
  int: (description) => ({ type: 'integer', description }),
};
const sessionArg = S.string('The session name from gb_session open. Every gb_* tool below needs it — parallel agents use separate sessions and never share one.');

const TOOLS = [
  {
    name: 'gb_session',
    description: 'Open/list/close/inspect/resize an isolated browser session. Open ONE per task with your task name (parallel agents = parallel sessions, never shared). op:open returns session info, a human-watchable URL, and the reminder that every other gb_* tool needs `session`. op:resize changes an EXISTING session\'s viewport (mobile checks without re-opening and re-seeding state). Artifacts (screenshots, verify reports, network logs, journal) land under a per-session dir on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['open', 'list', 'close', 'info', 'resize', 'export'], description: 'open a new session | list all | close one | info on one | resize one (needs viewport) | export the latest verify report as one self-contained .html (the sandbox stand-in for gb_watch, which needs a human who can reach this machine)' },
        name: S.string('session name (required for open/close/info/resize); 1-64 chars of [A-Za-z0-9._-]'),
        headed: S.bool('open a visible window — use for hover/tooltip/GPU-sensitive checks. Default is headless locally and HEADED (under Xvfb) in a container, for a real UA string and GPU-dependent rendering. Headless sees horizontal overflow correctly either way'),
        headless: S.bool('force headless even where headed is the default'),
        har: S.string('replay a HAR recording instead of hitting the network — the fidelity bridge for a sandbox whose egress is jailed. Carries the real API responses AND the real font files, so text-metric findings stop being about a substitute typeface'),
        harNotFound: { type: 'string', enum: ['fallback', 'abort'], description: "unmatched requests: 'fallback' (default) goes to the real network, 'abort' makes any unrecorded request a finding" },
        harUrl: S.string('glob limiting which URLs are served from the HAR (default: all)'),
        recordHar: S.string('RECORD a HAR to this path — run this on a machine with real network, then close the session to write the file'),
        timezone: S.string("IANA timezone (a container inherits UTC; the sandbox pins America/Los_Angeles unless told otherwise)"),
        locale: S.string('BCP-47 locale (a container inherits none)'),
        out: S.string('op:export only — where to write the .html (default: beside the report)'),
        viewport: { type: 'object', description: '{width,height} in CSS px (op:open initial size, or op:resize target size)', properties: { width: S.int(''), height: S.int('') } },
        colorScheme: { type: 'string', enum: ['light', 'dark'], description: 'initial prefers-color-scheme' },
        themeAttr: S.string("the site's own theme ATTRIBUTE on <html> (e.g. 'data-theme') so verify can sweep it alongside emulateMedia"),
        themeClass: S.string("the site's own theme CLASS on <html> (e.g. 'dark' for Tailwind darkMode:['class']) so verify can sweep it"),
        ignore404: { type: 'array', items: { type: 'string' }, description: "pathnames whose 404 is EXPECTED (e.g. ['/favicon.ico'] on a dev server) — verify demotes those rows to an info count and keeps them in the on-disk report. Only status-404 is demoted: a 500 or a transport failure on the same path still reports normally." },
        baseUrl: S.string('base URL so gb_goto can take relative paths'),
      },
      required: ['op'],
    },
  },
  {
    name: 'gb_goto',
    description: 'Navigate the session to a URL and wait for it to settle (composite quiescence, not the deprecated networkidle). Returns a delta: final url, whether it settled, console emitted, mutation count. Follow with gb_verify.',
    inputSchema: { type: 'object', properties: { session: sessionArg, url: S.string('absolute URL, or relative if the session has a baseUrl') }, required: ['session', 'url'] },
  },
  {
    name: 'gb_act',
    description: "Perform one UI action; `action` discriminates. Target the element by ANY of: selector (CSS — prefer this, you wrote the markup), testid, role+name, text, or ref (from gb_observe). Returns a delta (url change, console, mutations, settled) — NOT a full page dump. For type/select pass `value`; press pass `key`; scroll pass `to`/`by`; drag pass selector (from) + `to` (destination selector); upload pass `files`. A click whose target is COVERED at its hit point fails with ACT_OCCLUDED naming the covering element (a real pointer could not reach it) — pass force:true to do it anyway; the delta then carries forced:true.",
    inputSchema: {
      type: 'object',
      properties: {
        session: sessionArg,
        action: { type: 'string', enum: ['click', 'dblclick', 'hover', 'type', 'press', 'scroll', 'drag', 'upload', 'select'] },
        selector: S.string('CSS selector target'),
        testid: S.string('data-testid target'),
        role: S.string('ARIA role target (with `name`)'),
        name: S.string('accessible name (with `role`)'),
        text: S.string('visible-text target'),
        ref: S.string('a ref like e12 from a recent gb_observe (dies on DOM mutation → re-observe)'),
        value: S.string('text to type, or comma-separated values to select'),
        key: S.string('key for press, e.g. Enter, Tab, ArrowDown'),
        files: { type: 'array', items: { type: 'string' }, description: 'absolute file paths for upload' },
        to: S.string('scroll destination (top|bottom|CSS|ref) or drag destination selector'),
        by: S.int('scroll delta in px'),
        submit: S.bool('press Enter after typing'),
        force: S.bool('click/hover even when another element covers the target (stamped forced:true in the delta)'),
      },
      required: ['session', 'action'],
    },
  },
  {
    name: 'gb_observe',
    description: 'Get a distilled DOM+accessibility tree with numbered refs (e1, e2, …) as PLAIN TEXT — ~1.4k tokens, not the 95k raw tree. Un-ARIA\'d interactive nodes are flagged [no-ax], not hidden. Only needed when you do NOT already know the selector; if you wrote the code, act by selector directly. Refs die on the next mutation.',
    inputSchema: { type: 'object', properties: { session: sessionArg, selector: S.string('scope the snapshot to a subtree'), limit: S.int('page size'), cursor: S.int('pagination cursor from a prior call') }, required: ['session'] },
  },
  {
    name: 'gb_read',
    description: 'Read one buffered channel: console (all logs) | errors (console.error + uncaught, source-map-remapped) | network (failed|httpError|hanging|mixedContent taxonomy) | overlay (Vite/Astro/Next build-error overlay, extracted as text). Paginated via `since`/`limit`.',
    inputSchema: { type: 'object', properties: { session: sessionArg, channel: { type: 'string', enum: ['console', 'network', 'errors', 'overlay'] }, since: S.int('cursor (entry id) to read after'), limit: S.int('max entries') }, required: ['session', 'channel'] },
  },
  {
    name: 'gb_verify',
    description: 'THE go-to check: run this after any UI change. One call returns console errors + network taxonomy + layout pathology (overflow, occlusion, zero-size, broken images, contrast, CLS) + a11y + build-overlay, with the top findings inline and full detail + screenshots written to the session artifact dir. Optional theme/viewport sweep. ok:false means something is wrong — read the findings, fix the code, re-verify. Every report carries `navigation` (cold vs warm load): a WARM measurement understates first-load CLS and first-request 404s and says so — pass cold:true to re-navigate cache-cleared first.',
    inputSchema: {
      type: 'object',
      properties: {
        session: sessionArg,
        scope: S.string('CSS selector to limit the audit to a subtree'),
        themes: S.bool("sweep light AND dark (emulateMedia + a page RELOAD per leg so boot-time theme readers see it, + the session's themeAttr/themeClass). Byte-identical light/dark shots are reported as a finding."),
        viewports: S.bool('sweep mobile + desktop viewports'),
        axe: S.bool('run the axe-core a11y pass (default true; advisory, never flips ok)'),
        screenshots: S.bool('capture screenshots to disk (default true)'),
        themeReload: S.bool('reload per theme leg (default true) — set false to preserve in-page state across the sweep'),
        cold: S.bool('clear the HTTP cache and re-navigate before measuring, so first-load CLS and first-request failures are captured (a warm reload silently drops them)'),
        ignore404: { type: 'array', items: { type: 'string' }, description: 'extra expected-404 pathnames for this run, on top of the session allowlist' },
      },
      required: ['session'],
    },
  },
  {
    name: 'gb_screenshot',
    description: 'Capture a screenshot to a FILE PATH under the session shots/ dir and return that path (never an inline image — inline images cost 10-20x the tokens in Claude Code). If you need to SEE it, Read the returned path. Options: fullPage, a selector to clip to one element, or a theme to emulate. A fullPage capture first forces `content-visibility:auto` sections to paint (they otherwise stitch in as blank paper) and reports forcedPaint:N.',
    inputSchema: { type: 'object', properties: { session: sessionArg, fullPage: S.bool('capture the whole scrollable page'), selector: S.string('clip to this element'), theme: { type: 'string', enum: ['light', 'dark'], description: 'emulate this color-scheme for the shot' }, forcePaint: S.bool('force deferred content-visibility:auto sections to paint for a fullPage capture (default true)') }, required: ['session'] },
  },
  {
    name: 'gb_style',
    description: "Answer 'why does this element look wrong?' — computed styles, effective foreground/background contrast (WCAG AA), and the full cascade with COMPUTED specificity marking each declaration won ✓ / overridden ✗ (CDP ships no specificity; glassbox computes it). Use for wrong colors, invisible text, unexpected layout. Target by selector or ref.",
    inputSchema: { type: 'object', properties: { session: sessionArg, selector: S.string('CSS selector target'), ref: S.string('ref from gb_observe') }, required: ['session'] },
  },
  {
    name: 'gb_eval',
    description: 'Evaluate a JS expression in the live page and return its value (by value, or a bounded preview) PLUS any console output it emitted. Use for reading app state, computing a check, or poking a global. Refused while paused at a breakpoint (use gb_debug eval on the frozen frame instead).',
    inputSchema: { type: 'object', properties: { session: sessionArg, expression: S.string('a JS expression'), awaitPromise: S.bool('await the result if it is a Promise') }, required: ['session', 'expression'] },
  },
  {
    name: 'gb_wait',
    description: "Wait for ONE targeted condition, distinct from the automatic settle. `for` is an object: {selector} (visible) | {text} (appears in body) | {url} | {hydration:true} (Astro islands hydrated) | {timeout:ms} (plain sleep — always succeeds after the duration). A url pattern starting with '/' matches the PATHNAME ('/dashboard' matches /dashboard and /dashboard/x, never /dashboardx); anything else is a substring of the full href; '*' globs. NEVER throws on timeout — returns matched:false so you can branch.",
    inputSchema: {
      type: 'object',
      properties: {
        session: sessionArg,
        for: { type: 'object', description: 'exactly one of selector|text|url|hydration|timeout', properties: { selector: S.string(''), text: S.string(''), url: S.string(''), hydration: S.bool(''), timeout: S.int('ms to sleep') } },
        timeoutMs: S.int('overall budget (default 10000)'),
      },
      required: ['session', 'for'],
    },
  },
  {
    name: 'gb_debug',
    description: "White-box JS debugger in one tool; `op` selects the operation. break {file|urlRegex,line?,condition?} sets a breakpoint; then trigger it (a paused handler blocks that action — expected). While PAUSED, these work in a parallel lane: state (frames), inspect {frame?} (locals with values), eval {expression,frame?} (compute on the frozen frame), step {mode:over|into|out}, resume, pause, screenshot. list/remove manage breakpoints. listeners {selector|ref} answers whether a button is wired — it echoes WHICH node it inspected, warns when the selector matched several nodes (a bare 'button' hits the first one in the DOM), and before calling anything dead it checks ancestors for delegated handlers (React 17+ attaches at the root container). IMPORTANT lane rule: while paused, every non-debug tool returns PAUSED — resume first. Recipes: dead button → listeners; handler logic → break+inspect+eval+resume.",
    inputSchema: {
      type: 'object',
      properties: {
        session: sessionArg,
        op: { type: 'string', enum: ['break', 'list', 'remove', 'state', 'inspect', 'eval', 'step', 'resume', 'pause', 'screenshot', 'listeners'] },
        file: S.string('script URL suffix, e.g. app.js (for break)'),
        urlRegex: S.string('breakpoint by URL regex instead of file'),
        line: S.int('1-based line (snaps to the first valid location at/after it)'),
        condition: S.string('conditional-breakpoint expression'),
        frame: S.int('call-frame index for inspect/eval (0 = top)'),
        expression: S.string('expression for op:eval (evaluated on the frozen frame)'),
        mode: { type: 'string', enum: ['over', 'into', 'out'], description: 'step mode' },
        selector: S.string('element for op:listeners'),
        ref: S.string('ref for op:listeners'),
        breakpointId: S.string('id for op:remove'),
        all: S.bool('op:remove all breakpoints'),
      },
      required: ['session', 'op'],
    },
  },
  {
    name: 'gb_coverage',
    description: 'JS + CSS coverage. op:start BEFORE navigating, op:stop after exercising the UI → a report path listing functions with count===0 ("this handler never ran") and unused CSS rules, both source-mapped. Use to prove code you expected to run actually ran.',
    inputSchema: { type: 'object', properties: { session: sessionArg, op: { type: 'string', enum: ['start', 'stop'] } }, required: ['session', 'op'] },
  },
  {
    name: 'gb_dialog',
    description: 'Respond to a pending native dialog (alert/confirm/prompt) surfaced by a prior action. action:accept|dismiss, optional text for a prompt. Dialogs are stashed, never left hanging — but they DO block further actions until you answer.',
    inputSchema: { type: 'object', properties: { session: sessionArg, action: { type: 'string', enum: ['accept', 'dismiss'] }, text: S.string('prompt text when accepting a prompt()') }, required: ['session', 'action'] },
  },
  {
    name: 'gb_watch',
    description: 'Get a human-watchable live URL for this session (screencast + click/key takeover) plus a copy-paste DevTools string. Relay the URL to your human when they want to see or drive the browser you are testing.',
    inputSchema: { type: 'object', properties: { session: sessionArg }, required: ['session'] },
  },
];

// ---- daemon route mapping per tool ------------------------------------------

/** Resolve an action target object from gb_act args (ref > testid > role[+name] > selector > text). */
function actTarget(a, allowText) {
  if (a.ref) return { ref: a.ref };
  if (a.testid) return { testid: a.testid };
  if (a.role) return { role: a.role, ...(a.name ? { name: a.name } : {}) };
  if (a.selector) return { selector: a.selector };
  if (allowText && a.text) return { text: a.text };
  return {};
}

function actBody(a) {
  switch (a.action) {
    case 'type': return { ...actTarget(a, false), text: a.value ?? a.text ?? '', ...(a.submit ? { submit: true } : {}) };
    case 'press': return { key: a.key, ...actTarget(a, false) };
    case 'scroll': return { ...(a.to ? { to: a.to } : {}), ...(a.by != null ? { by: Number(a.by) } : {}), ...(a.ref ? { ref: a.ref } : {}) };
    case 'drag': return { from: a.selector ? { selector: a.selector } : actTarget(a, false), to: { selector: a.to } };
    case 'upload': return { ...actTarget(a, true), files: Array.isArray(a.files) ? a.files : (a.files ? String(a.files).split(',').filter(Boolean) : []) };
    case 'select': return { ...actTarget(a, true), values: Array.isArray(a.value) ? a.value : (a.value ? String(a.value).split(',').filter(Boolean) : []) };
    default: return { ...actTarget(a, true), ...(a.force ? { force: true } : {}) }; // click, dblclick, hover
  }
}

const enc = (name) => encodeURIComponent(name);

/**
 * Map a tool call to a daemon request. Returns {method, route, body?} or throws a local
 * validation error (missing required arg) as a gbErr-shaped object.
 */
function planCall(tool, a) {
  const needSession = () => { if (!a.session) throw { gb: { code: 'BAD_REQUEST', message: `${tool} needs a \`session\` (open one with gb_session {op:'open', name})`, field: 'session' } }; return a.session; };
  switch (tool) {
    case 'gb_session': {
      const op = a.op;
      if (op === 'open') {
        if (!a.name) throw { gb: { code: 'BAD_REQUEST', message: 'gb_session open needs a `name`', field: 'name' } };
        const body = { name: a.name };
        for (const k of ['headed', 'headless', 'viewport', 'colorScheme', 'themeAttr', 'themeClass', 'ignore404', 'baseUrl',
          // sandbox backend: the HAR bridge + explicit environment pinning
          'har', 'harNotFound', 'harUrl', 'recordHar', 'timezone', 'locale']) if (a[k] != null) body[k] = a[k];
        return { method: 'POST', route: '/sessions', body };
      }
      // Sandbox human channel. Rides inside gb_session for the same reason resize does: the
      // 14-tool ceiling is a hard contract (research 04).
      if (op === 'export') return { method: 'POST', route: `/sessions/${enc(needName(a))}/export`, body: a.out ? { out: a.out } : {} };
      if (op === 'list') return { method: 'GET', route: '/sessions' };
      if (op === 'info') return { method: 'GET', route: `/sessions/${enc(needName(a))}` };
      if (op === 'close') return { method: 'DELETE', route: `/sessions/${enc(needName(a))}` };
      // D11 rides inside gb_session on purpose: the 14-tool ceiling is a hard contract (research 04).
      if (op === 'resize') {
        const name = needName(a);
        const vp = a.viewport || {};
        if (!vp.width || !vp.height) throw { gb: { code: 'BAD_REQUEST', message: 'gb_session resize needs `viewport` {width,height}', field: 'viewport' } };
        return { method: 'POST', route: `/sessions/${enc(name)}/viewport`, body: { width: Number(vp.width), height: Number(vp.height) } };
      }
      throw { gb: { code: 'BAD_REQUEST', message: `gb_session needs op:open|list|close|info|resize`, field: 'op', valid_values: ['open', 'list', 'close', 'info', 'resize'] } };
    }
    case 'gb_goto': return { method: 'POST', route: `/sessions/${enc(needSession())}/goto`, body: { url: a.url } };
    case 'gb_act': {
      const s = needSession();
      if (!a.action) throw { gb: { code: 'BAD_REQUEST', message: 'gb_act needs an `action`', field: 'action' } };
      return { method: 'POST', route: `/sessions/${enc(s)}/${a.action}`, body: actBody(a) };
    }
    case 'gb_observe': return { method: 'POST', route: `/sessions/${enc(needSession())}/observe`, body: { ...(a.selector ? { selector: a.selector } : {}), ...(a.limit ? { limit: Number(a.limit) } : {}), ...(a.cursor ? { cursor: Number(a.cursor) } : {}) } };
    case 'gb_read': return { method: 'POST', route: `/sessions/${enc(needSession())}/read`, body: { channel: a.channel, ...(a.since ? { since: Number(a.since) } : {}), ...(a.limit ? { limit: Number(a.limit) } : {}) } };
    case 'gb_verify': return { method: 'POST', route: `/sessions/${enc(needSession())}/verify`, body: { ...(a.scope ? { scope: a.scope } : {}), ...(a.themes ? { themes: true } : {}), ...(a.viewports ? { viewports: true } : {}), ...(a.axe === false ? { axe: false } : {}), ...(a.screenshots === false ? { screenshots: false } : {}), ...(a.themeReload === false ? { themeReload: false } : {}), ...(a.cold ? { cold: true } : {}), ...(Array.isArray(a.ignore404) && a.ignore404.length ? { ignore404: a.ignore404 } : {}) } };
    case 'gb_screenshot': return { method: 'POST', route: `/sessions/${enc(needSession())}/screenshot`, body: { ...(a.fullPage ? { fullPage: true } : {}), ...(a.selector ? { selector: a.selector } : {}), ...(a.theme ? { theme: a.theme } : {}), ...(a.forcePaint === false ? { forcePaint: false } : {}) } };
    case 'gb_style': {
      const s = needSession();
      if (!a.selector && !a.ref) throw { gb: { code: 'BAD_REQUEST', message: 'gb_style needs a `selector` or `ref`', field: 'selector' } };
      return { method: 'POST', route: `/sessions/${enc(s)}/style`, body: a.ref ? { ref: a.ref } : { selector: a.selector } };
    }
    case 'gb_eval': {
      const s = needSession();
      if (!a.expression) throw { gb: { code: 'BAD_REQUEST', message: 'gb_eval needs an `expression`', field: 'expression' } };
      return { method: 'POST', route: `/sessions/${enc(s)}/eval`, body: { expression: a.expression, ...(a.awaitPromise ? { awaitPromise: true } : {}) } };
    }
    case 'gb_wait': return { method: 'POST', route: `/sessions/${enc(needSession())}/wait`, body: { for: a.for || {}, ...(a.timeoutMs ? { timeoutMs: Number(a.timeoutMs) } : {}) } };
    case 'gb_debug': {
      const s = needSession();
      if (!a.op) throw { gb: { code: 'BAD_REQUEST', message: 'gb_debug needs an `op`', field: 'op', valid_values: ['break', 'list', 'remove', 'state', 'inspect', 'eval', 'step', 'resume', 'pause', 'screenshot', 'listeners'] } };
      const body = { op: a.op };
      for (const k of ['file', 'urlRegex', 'line', 'condition', 'frame', 'expression', 'mode', 'selector', 'ref', 'breakpointId', 'all']) if (a[k] != null) body[k] = a[k];
      return { method: 'POST', route: `/sessions/${enc(s)}/debug`, body };
    }
    case 'gb_coverage': {
      const s = needSession();
      const op = a.op === 'start' ? 'coverage-start' : a.op === 'stop' ? 'coverage-stop' : null;
      if (!op) throw { gb: { code: 'BAD_REQUEST', message: 'gb_coverage needs op:start|stop', field: 'op', valid_values: ['start', 'stop'] } };
      return { method: 'POST', route: `/sessions/${enc(s)}/debug`, body: { op } };
    }
    case 'gb_dialog': return { method: 'POST', route: `/sessions/${enc(needSession())}/dialog`, body: { action: a.action || 'dismiss', ...(a.text != null ? { text: a.text } : {}) } };
    case 'gb_watch': return { method: 'GET', route: `/sessions/${enc(needSession())}` }; // info → build the watch URL from it
    default: throw { gb: { code: 'BAD_REQUEST', message: `unknown tool '${tool}'` } };
  }
  function needName(x) { if (!x.name) throw { gb: { code: 'BAD_REQUEST', message: `gb_session ${x.op} needs a \`name\``, field: 'name' } }; return x.name; }
}

// ---- result formatting ------------------------------------------------------

/** Cap inline text; spill-reference the artifact path so nothing is silently lost (research 04 §5.4). */
function capText(text, artifactPath) {
  if (text.length <= MAX_TEXT) return text;
  const where = artifactPath ? `full detail at ${artifactPath}` : 'full detail in the session artifact dir';
  return text.slice(0, MAX_TEXT - 120) + `\n…[truncated — ${where}]`;
}

const compact = (obj) => { try { return JSON.stringify(obj); } catch { return String(obj); } };

/** Format a successful daemon body into agent-facing text (observe tree as-is; else compact JSON). */
function formatOk(tool, a, body, daemon) {
  if (tool === 'gb_observe') {
    const tail = `\n[v${body.version} · ${body.count} node(s)${body.nextCursor != null ? ` · more: cursor ${body.nextCursor}` : ''}]`;
    return capText((body.text || '(empty tree)') + tail, body.axPath);
  }
  if (tool === 'gb_session' && a.op === 'open') {
    const watchUrl = `http://127.0.0.1:${daemon.port}/watch/${enc(body.name)}?token=${daemon.token}`;
    return compact({
      ...body, watchUrl,
      hint: 'pass this `name` as `session` to every other gb_* tool; give watchUrl to a human to watch. This session is OWNED by the `client` shown — other agents sharing this machine cannot reap it without --force, and you clean up with `glassbox kill-all --mine` (or gb_session close).',
    });
  }
  if (tool === 'gb_watch') {
    const watchUrl = `http://127.0.0.1:${daemon.port}/watch/${enc(a.session)}?token=${daemon.token}`;
    return compact({ ok: true, session: a.session, watchUrl, devtoolsFrontend: body.cdp?.devtoolsFrontend || null, hint: 'relay watchUrl to the human; devtoolsFrontend pastes into a Chromium address bar.' });
  }
  const artifact = body.artifacts?.report || body.axPath || body.path || null;
  return capText(compact(body), artifact);
}

/** Serialize a structured daemon error so it is self-correcting from the text alone. */
function formatError(err) {
  const e = err || { code: 'INTERNAL', message: 'unknown error' };
  const lines = [`ERROR ${e.code || 'INTERNAL'}: ${e.message || ''}`];
  if (e.field) lines.push(`  field: ${e.field}`);
  if (e.correction_hint) lines.push(`  correction_hint: ${e.correction_hint}`);
  if (Array.isArray(e.valid_values)) lines.push(`  valid_values: ${e.valid_values.join(', ') || '(none)'}`);
  if (e.blockedBy) lines.push(`  blockedBy: ${e.blockedBy}`);
  if (e.actionability) lines.push(`  actionability: ${e.actionability}`);
  return lines.join('\n');
}

const okResult = (text) => ({ content: [{ type: 'text', text }] });
const errResult = (text) => ({ content: [{ type: 'text', text }], isError: true });

async function callTool(tool, args) {
  const a = args || {};
  let plan;
  try {
    plan = planCall(tool, a);
  } catch (e) {
    return errResult(formatError(e.gb || { code: 'BAD_REQUEST', message: e?.message || 'bad arguments' }));
  }
  let daemon;
  try {
    daemon = await getDaemon();
  } catch (e) {
    return errResult(formatError(e.gb || { code: 'DAEMON_UNREACHABLE', message: e?.message || 'daemon unreachable' }));
  }
  let res;
  try {
    res = await callDaemon(plan.method, plan.route, plan.body);
  } catch (e) {
    return errResult(formatError({ code: 'DAEMON_UNREACHABLE', message: e?.message || 'daemon request failed' }));
  }
  if (res.status !== 200) return errResult(formatError(res.body?.error || { code: 'INTERNAL', message: `HTTP ${res.status}` }));
  return okResult(formatOk(tool, a, res.body, daemon));
}

// ---- JSON-RPC dispatch ------------------------------------------------------

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize': {
      const clientV = params && params.protocolVersion;
      const protocolVersion = KNOWN_PROTOCOLS.has(clientV) ? clientV : LATEST_PROTOCOL;
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'notifications/initialized':
    case 'initialized':
      return null; // notification — no response
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcResult(id, errResult(formatError({ code: 'BAD_REQUEST', message: `unknown tool '${name}'`, valid_values: TOOLS.map((t) => t.name) })));
      const result = await callTool(name, params.arguments || {});
      return rpcResult(id, result);
    }
    default:
      if (isNotification) return null; // ignore unknown notifications
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

// ---- stdio transport (newline-delimited, serial writes) ---------------------

function write(msg) {
  if (!msg) return;
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (e) { logErr('stdout write failed:', e?.message); }
}

export function runShim() {
  // IDENTITY (defect round 4): one daemon serves every agent on the machine, so every session
  // records who opened it and the destroy verbs scope on that. A shim process is long-lived and
  // one-per-agent, which makes its pid the natural stable id — set it once, and protocol.daemonReq
  // stamps it on every request, so MCP users get ownership for free. An explicitly-set
  // GLASSBOX_CLIENT still wins: an operator naming their agent outranks a guess.
  if (!process.env.GLASSBOX_CLIENT) process.env.GLASSBOX_CLIENT = `mcp-${process.pid}`;
  logErr(`glassbox mcp client id: ${process.env.GLASSBOX_CLIENT}`);
  // Warm the daemon in the background so the first tool call is fast, without blocking initialize.
  getDaemon().catch((e) => logErr('daemon warmup deferred:', e?.message));

  let buf = '';
  let chain = Promise.resolve(); // serialize handling so responses never interleave on stdout
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      chain = chain.then(() => processLine(line)).catch((e) => logErr('handler crashed:', e?.stack || e));
    }
  });
  process.stdin.on('end', () => { chain.finally(() => process.exit(0)); });
  process.stdin.on('error', (e) => { logErr('stdin error:', e?.message); process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  logErr(`glassbox mcp shim ready (${SERVER_INFO.name}/${SERVER_INFO.version})`);
}

async function processLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    write(rpcError(null, -32700, 'parse error')); // malformed JSON — never crash
    return;
  }
  if (Array.isArray(msg)) { // batch: handle each, emit non-null responses
    for (const m of msg) { const r = await safeHandle(m); if (r) write(r); }
    return;
  }
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    write(rpcError(msg && msg.id, -32600, 'invalid request'));
    return;
  }
  write(await safeHandle(msg));
}

async function safeHandle(msg) {
  try {
    return await handleRpc(msg);
  } catch (e) {
    logErr('rpc handler error:', e?.stack || e);
    return (msg && (msg.id !== undefined && msg.id !== null)) ? rpcError(msg.id, -32603, e?.message || 'internal error') : null;
  }
}

// Run when executed directly (`node src/mcp-shim.mjs`); `glassbox mcp` imports and calls runShim().
if (process.argv[1] && (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')))) {
  runShim();
}
