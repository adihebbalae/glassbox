# Glassbox — architecture (decided)

*2026-07-23. Every decision cites its evidence: `spikes/SPIKES.md` (hands-on proof) or
`docs/research/NN-*.md` (literature). This document is the contract the build implements.*

## 0. Positioning (from research 01, 03, 08)

Glassbox is **not** a general agent-browser. It is a **local, daemon-shaped, session-parallel,
instrumented-to-the-floor browser for coding agents verifying their own UI**. The moat, in
priority order — each one a documented, unfilled gap in every surveyed tool:

1. **Named parallel isolated sessions** as the default topology (playwright-mcp #1530 closed
   not-planned; chrome-devtools-mcp #926 open; agent-browser #1068 leaks storage).
2. **One-call verification bundles** — console + network taxonomy + a11y + layout pathology +
   screenshots in one structured report (nobody bundles; 80%→0% invalid-action evidence, research 08).
3. **White-box debug plane** — breakpoints, coverage, cascade introspection (thinnest layer
   industry-wide; open FRs on Google's own server, #86/#731; proven feasible in spikes 1-2).
4. **CLI + MCP duality on one daemon** (Playwright's own 114k-vs-27k token benchmark, research 04).
5. **Artifact-directory-per-session contract** on disk (unclaimed; Claude Code's 10-20× inline
   image token tax, issue #31208, makes path-returns mandatory).

## 1. Runtime: Playwright library + CDPSession escape hatch

**Decision**: Node 24 ESM, no build step. One runtime dependency: `playwright` (engine
lifecycle). White-box features go through `context.newCDPSession(page)` raw CDP.

- Playwright owns what is genuinely hard and already hardened: launch/cleanup (taskkill /T /F
  on win32), target/frame lifecycle, actionability auto-wait (visible/stable/receives-events/
  enabled/editable), input dispatch, shadow-DOM-piercing selectors, uploads, downloads,
  emulation. Electron/CEF/exotic engines disqualified on evidence (research 03). Atlas
  shutdown confirms "ship a browser app" is the losing shape (research 01).
- Raw CDP owns what Playwright doesn't expose: Debugger (breakpoints/pause/evaluateOnCallFrame
  — never Runtime.evaluate while paused, research 02), Profiler + CSS coverage,
  CSS.getMatchedStylesForNode (cascade — we compute specificity ourselves; CDP doesn't ship
  it, research 02), Accessibility.getFullAXTree, DOMSnapshot.captureSnapshot,
  Page.startScreencast (ack every frame; size from CSS×DPR), Overlay.highlightNode,
  DOMDebugger.getEventListeners. All spike-proven.
- **Sessions = named BrowserContexts in one shared browser process** (~250ms, storage-isolated
  — spike 1; contexts-in-process beats process-per-session by GB at scale, research 03).
  Headless=new default; `headed: true` per session for fidelity-sensitive checks (hover/
  tooltip/GPU gaps, research 03). Debugger pause is per-session; siblings unaffected (spike 2).

## 2. Topology

```
┌──────────────┐  stdio   ┌──────────────────────────── glassboxd (daemon) ─┐
│ MCP shim ×N  │─────────▶│ HTTP+WS control plane, 127.0.0.1:0 + bearer token│
├──────────────┤  HTTP    │  ┌ SessionManager: name → BrowserContext + page  │
│ CLI `glassbox`│────────▶│  │   + CDP session + buffers + artifact dir      │
├──────────────┤   WS     │  ├ Verification engine (bundles)                 │
│ watch page   │◀────────▶│  ├ Debug plane (per-session CDP)                 │
└──────────────┘screencast│  └ Journal writer (JSONL per session)            │
                          │ Playwright → Chromium (headless shared + headed) │
                          └──────────────────────────────────────────────────┘
```

- **Daemon discovery**: atomic `%LOCALAPPDATA%\glassbox\daemon.json` `{port, token, pid,
  startTime}`; loopback-only bind (zero firewall prompts); liveness = ping + functional probe;
  PID-reuse-safe kill; auto-start-on-demand from CLI/shim. All patterns copied from
  browser-harness's field-tested win32 IPC design (research 07).
- **MCP shim**: thin stdio JSON-RPC process per Claude session, statelessly proxying to the
  daemon — process-proliferation is harmless because shims hold no browser state (the fat-server
  kernel-panic failure mode, research 04). Hand-rolled MCP (protocol is small); swap to SDK
  only if Claude Code interop testing forces it.
- **Runtime state** under `%LOCALAPPDATA%\glassbox\` (short path — MAX_PATH, research 07):
  `sessions/<name>/journal.jsonl`, `shots/`, `net/`, `reports/`. Repo holds code only.
- **Concurrency**: session name is an explicit parameter on every call; per-session command
  queues inside the daemon (serialize within a session, full parallelism across sessions) —
  transport sharing alone does not grant concurrency (research 04).

## 3. Observation model (research 06 + spike 3)

- Default observation = **distilled hybrid DOM+AX snapshot**: merged from CDP DOM + AXTree,
  numbered integer refs backed by `backendNodeId`, un-ARIA'd interactive nodes *flagged, not
  hidden* (freshly-written UI has the worst a11y tree — pure-AX tools go blind exactly here).
  Spike 3: raw AXTree ≈95k tokens, distilled ≈1.4k. Raw dumps go to disk, never inline.
- **Selector-first grounding**: the caller *wrote* the code — CSS/test-id/text/role selectors
  are first-class action targets alongside refs (no surveyed tool has this; genuine edge).
- Refs invalidate on DOM mutation → structured "ref died, re-observe" error, never a silent
  mis-click. Screenshots are on-demand attachments (file paths), not per-step defaults.
- **An action never lies about what a user could do**: a click whose hit point belongs to another
  element fails `ACT_OCCLUDED` (same rule the layout audit uses, so `act` and `verify` can never
  contradict each other); `force` is an explicit opt-in and is stamped `forced:true` in the delta.
- Every action returns a **delta**: url change, console events since, dialog/overlay-blocking
  state (never let a native dialog hang a call — playwright-mcp #595), and a short mutation
  summary. Verification is structural, not optional (research 08).

## 4. Settling (research 05)

`networkidle` is a deprecated trap. Settle = composite: navigation/loadEvent when applicable →
in-flight request count low-water → debounced `MutationObserver` (subtree) + chained rAF →
framework signal when detectable (**Astro: `astro-island[ssr]` attribute removal** — first-class
since it's Adi's stack; React: heuristic only). Hard cap with explicit `settled: false` in the
result rather than a hang. Per-tab setup: `Network.setBypassServiceWorker(true)` +
`setCacheDisabled(true)` (stale-build false reports, research 07).

## 5. Verification engine (research 05)

`verify` = one call, per-session, all channels, artifacts to disk, compact report inline:
- **Errors**: context-scoped console/pageerror/weberror buffers (page-scoped listeners miss
  iframes/workers), source-map-remapped stacks (daemon fetches `.map`s; raw minified stacks are
  useless to the fixing agent).
- **Network taxonomy**: `failed | httpError | mixedContent | hanging` — 4xx/5xx never fire
  `requestfailed` (transport success!), so naive listeners miss every HTTP error; hanging =
  in-flight beyond threshold.
- **Layout pathology** (one injected JS payload, one round-trip): horizontal overflow,
  occlusion via `elementFromPoint`, `Element.checkVisibility()`, zero-size targets, broken
  images (`complete && naturalWidth===0`), effective fg/bg contrast pairs (spike 1), CLS via
  buffered `layout-shift` PerformanceObserver with source nodes. Unpaintedness is GRADED, never
  lumped: `display:none` / `content-visibility:hidden` = deliberate (silent); an ancestor's
  `visibility:hidden` = one grouped warning naming that ancestor; `content-visibility:auto` =
  **deferred**, an info line only (it paints on scroll — a performance primitive, not a hide); a
  closed `<details>` / `hidden="until-found"` = **collapsed**, one info line naming the widget (it
  paints on toggle); a modal backdrop = one info line for everything behind it. And when NOTHING in
  the DOM ancestor chain explains a hide — a UA pseudo-element like `::details-content`, a shadow
  root — the finding says exactly that instead of naming a mechanism the computed styles
  contradict. An audit that invents a cause sends the fixer to the wrong file.
- **Load state**: every report says whether it measured a COLD or a WARM load, because a warm one
  cannot see first-load CLS or a negatively-cached 404, and reports the warm caveat as a finding.
  `cold:true` clears the HTTP cache and re-navigates. Per-tab `Network.setCacheDisabled(true)` is
  verified to work for every renderer-initiated request; Chrome's browser-process favicon cache is
  outside CDP's reach and is documented as a limit rather than pretended away.
- **Expected-404 allowlist**: `ignore404` demotes matching **status-404** rows to an info count
  (and the browser's matching resource-load console error), never any other status, and never
  deletes them from the on-disk report.
- **Screenshots must paint what they stitch**: a full-page capture first forces
  `content-visibility:auto` subtrees to render (via an INSPECTOR stylesheet — not a DOM node, so
  the MutationObserver never fires and observe refs survive), since `captureBeyondViewport` alone
  stitches blank paper over them. An element (clipped) capture does the same, and converts the clip
  into PAGE coordinates: `DOM.getBoxModel` answers in VIEWPORT coordinates, so an un-converted clip
  is only correct at scroll 0 — after which every element screenshot silently framed the wrong
  region. A clip that still comes back featureless on a visibly-populated element returns a
  `warning`; a blank primary artifact is never handed back silently.
- **a11y**: vendored axe-core, scoped by default, structural dedup (card grids), contrast rule
  cost-aware.
- **Sweeps**: viewport set (mobile/tablet/desktop) × theme — driving *all three* of
  `emulateMedia(colorScheme)`, the site's own `data-theme` attribute, and its root **class**
  (Tailwind `darkMode:['class']`); one does not test the others, and stale-persisted-theme is a
  real bug class. Each theme leg **reloads** after setting emulation (a site that reads
  `prefers-color-scheme` once at module load cannot see a runtime flip — the sweep would silently
  screenshot the light theme twice), and byte-identical light/dark output is itself a finding.
- **Overlay reader**: generic open-shadow-root walker for `<vite-error-overlay>`, Astro's
  overlay, `<nextjs-portal>` (all open shadow DOM — research 07) so build errors surface as
  structured fields, not screenshots of red boxes.

## 6. Debug plane (spike 2 + research 02, 05)

Breakpoints resolved via `Debugger.getPossibleBreakpoints` (spike 2's off-by-one lesson);
pause/step/resume; `evaluateOnCallFrame` + scope dump; screenshot-while-paused (spike-proven);
JS coverage (`count===0` = "this handler never ran") and CSS rule-usage, both source-mapped;
`style` tool answering *why*: matched rules in cascade order with computed specificity (we
compute it — CDP doesn't), inheritance chain, effective contrast. Event-listener listing per
node. React fiber inspection (vendored bippy-style walker) strictly opt-in — version-fragile.

## 7. Ride-along (research 03 + spike 3)

`glassbox watch <session>` → daemon-served local page: WS screencast (~6fps, ack-driven,
CSS×DPR-sized), click/key forwarding for take-over, session grid. "Real DevTools" link via
vendored/pinned devtools-frontend against the session's CDP ws URL (proven pattern: Google
appspot, Cloudflare). Multi-client CDP attach is supported since Chrome 63 (research 02) —
human DevTools + daemon coexist on one target.

## 8. Interfaces

**CLI verbs = MCP tools = same daemon endpoints.** ~14 tools (bloat causes redundant agent
behavior, research 04/08): `session` (create/list/destroy/info), `goto`, `act` (click/type/
press/hover/scroll/drag/upload/select), `observe`, `read` (console/network/errors, cursored),
`verify`, `screenshot`, `style`, `eval`, `wait`, `debug` (breakpoint/pause/step/inspect),
`coverage`, `dialog`, `artifacts`. Structured errors everywhere: `{code, message, field,
correction_hint, valid_values}` as `isError` content — a stale ref or bad session name is a
correctable next call, not a dead end. Lists paginated from day one. Images/large payloads →
file paths, always.

## 9. Non-goals (v1)

Cloud/remote browsers; stealth/CAPTCHA anything; cross-engine (BiDi) abstraction; perf-trace
UI (chrome-devtools-mcp does it; wrap later); Electron shell; scraping ergonomics. WebMCP
(Chrome 149 origin trial) is a watch-item only.
