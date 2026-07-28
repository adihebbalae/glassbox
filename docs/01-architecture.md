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
- **Ownership** (defect round 4): the daemon is machine-wide and SHARED between agents, so every
  session records the client that opened it (`--client` > `GLASSBOX_CLIENT` > `anonymous`; the MCP
  shim uses `mcp-<pid>` so MCP agents get it for free) and every request carries that id in a
  header. A shared daemon is a sound architecture; a shared *destroy* verb without an ownership
  model is not: `kill-all --mine` is scoped to the caller, a bare `kill-all`/`daemon stop` REFUSES
  (structured `FOREIGN_SESSIONS`, naming the other clients) while someone else's sessions have been
  used inside a 5-minute window, and `--force` keeps the machine-wide power for wedge recovery.
  Anonymous is deliberately not an identity — anonymous callers own anonymous sessions, so the
  single-agent path is unchanged.

  **Corrected 2026-07-28 (§11.8).** All of that machinery lives on the daemon, so it only engages
  when the daemon is *reachable*. With the discovery file missing or stale, `killAll()` skipped the
  `/shutdown` request entirely and fell through to `sweepOrphans()`, which matches chromium on the
  chrome-data marker and has no notion of an owner — so `--mine` went machine-wide in exactly the
  case where it could not establish that anything was the caller's. `--mine` now asks whether any
  daemon is still alive before sweeping: none alive means nobody can own anything and the sweep is
  the normal end-of-task cleanup; an unreferenced daemon alive means `--force` is the verb you want.

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

## 11. The platform seam (2026-07-28)

Glassbox runs in two places now: a developer's own machine, and an ephemeral Linux container where
an agent both writes the code and checks it. **One codebase, two backends** — the verb surface, the
finding engine, the noise discipline and the report shape are shared and untouched. Four members
swap underneath, all decided in `src/platform.mjs` and nowhere else:

1. **Launcher.** Local: `channel:'chromium'`, headless default. Sandbox: a Chromium resolved by
   PATH (playwright pins a browser revision per release; an image shipping a different one fails
   channel resolution, and `playwright install` cannot fetch through a package-registry-only egress
   allowlist), **headed under Xvfb by default**, `--disable-dev-shm-usage`, timezone and locale
   pinned rather than inherited.
2. **Network policy.** Local: passthrough. Sandbox: a fifth taxonomy bucket plus HAR replay.
3. **Human channel.** Local: the live `watch` screencast. Sandbox: an exported self-contained HTML
   report, because nobody can reach that box's loopback.
4. **Lifecycle.** Same daemon both sides; ownership machinery is a no-op in a single-tenant
   container, and the process reaper gets a real POSIX implementation.

### 11.1 Headed is the sandbox default

Headed remains the sandbox default for two reasons: headless leaves `HeadlessChrome` in the UA,
which apps branch on, and GPU-dependent rendering differs. Xvfb costs one ~30MB process, which is
cheap enough for both.

It used to rest on a third and much larger reason — that headless could not see `100vw` horizontal
overflow or right-edge clipping at all — and that reason was **the right measurement attached to
the wrong cause**. The record, because the mistake is more instructive than the finding:

**Correction, 2026-07-28.** This section read "a headless launch reports a scrollbar width of 0px
(overlay scrollbars)". The 0px was real; overlay scrollbars were not the cause. It is
`--hide-scrollbars`, which Playwright appends to every headless launch unconditionally
(`playwright-core` `coreBundle.js:42539`, `:42744`, guarded only by `if (options.headless)`) so
that visual comparisons stay deterministic across platforms with different scrollbar widths.
Re-measured, 800×600, `100vw` child:

| launch config | gutter | overflow detected |
| --- | --- | --- |
| headless, Playwright defaults | 0px | no |
| headless + `ignoreDefaultArgs: ['--hide-scrollbars']` | 15px | yes |
| headed | 15px | yes |

So headless was never structurally blind. `launchOptions()` was, by inheriting a flag it never
chose, and this section blamed the renderer for a launcher default. **Fixed the same day:**
`launchOptions()` now passes `ignoreDefaultArgs: ['--hide-scrollbars']` when headless, with
`GLASSBOX_HIDE_SCROLLBARS=1` as the opt-out for anyone diffing screenshots across machines — where
Playwright's reasoning is correct and the blind spot is an acceptable trade. Full suite green
before and after (293 checks, then 295).

**Why the suite did not catch it, which is the part worth keeping.** The only seeded overflow
fixture was `layout.html`'s `#wide { width: 3000px }` — it overflows an 800px viewport by ~2200px
and is detected with or without a gutter. The case the flag actually erases is one that overflows
by *exactly* the scrollbar width, and it was never seeded. So the overflow assertion passed in a
configuration that could not see the class it was named after: a **vacuous pass** (defect class W3),
committed against the project's own headline finding. `test/bugzoo/overflow-vw.html` now seeds the
`100vw` case; `m3` check 4i and the `m8` seed matrix pin it, and both fail against every commit
before this one — verifiable on demand with `GLASSBOX_HIDE_SCROLLBARS=1`.

The general rule this pays for: **an assertion is only as good as the fixture's sensitivity to the
thing it claims to test.** A fixture gross enough to survive the failure mode you care about is not
coverage, it is decoration.

Fallout worth recording: a headed Chromium exits when its last window closes, and a persistent
context's default `about:blank` page IS that window. `ensureBrowser` used to close it
unconditionally; in headed mode that took the browser with it and the next `newContext` failed with
"Target page, context or browser has been closed". Headless has no window to lose, which is why it
never surfaced before.

### 11.2 Egress is measured, and gets its own bucket

An agent sandbox routes outbound traffic through an allowlisting proxy: package registries pass,
everything else gets 403. Verified on the reference image for curl, Node, Playwright's request
context and in-page `fetch`, with and without an explicit `--proxy-server`. Two consequences that
are *not* the caller's code:

- **Tunnels and preview deployments are structurally dead.** Both need the container to fetch a
  public URL. The app under test must run in the sandbox; there is no second option to design for.
- **The four-bucket taxonomy inverts.** Run a normal app in that jail and every font, CDN script
  and API call lands in `failed`, so verify reports a wall of red that says nothing about the code —
  and real failures disappear inside the noise.

So: `sandboxBlocked`, a fifth bucket, filled only on evidence (proxy-refusal errorText, or 403/407)
and never for a same-origin or loopback request — *a broken local API can never be excused as "the
sandbox did it"*. Blocked rows are demoted, never deleted (the contract `ignore404` already keeps),
collapse to one info line naming the hosts, and are excluded from `ok`. The daemon **probes** egress
at startup against a canary rather than inferring it from environment variables; the report states
what the probe found.

### 11.3 Conditions, and per-finding portability

The W3 lesson (a warm load quietly loses first-load findings, so every report says which it
measured) generalises to the environment itself. Every verify now carries a `conditions` block —
platform, display mode, browser, raster, egress, fonts, viewport, colour scheme, timezone, load —
and every finding carries a `portability` tag:

- `portable` — computed from values the browser was *given*: CSS colours and contrast, the cascade,
  the DOM, HTTP status, coverage, hit-test occlusion. Means the same thing on any machine.
- `font-dependent` — measured off *rendered text*: overflow, occlusion, clipping, CLS. This image
  has Liberation and DejaVu and no Segoe UI, Inter or Roboto, so `system-ui` resolves to a face the
  developer never sees. Tagged only when fonts really were substituted.
- `sandbox-artifact` — a fact about the environment, not the code.

`fonts: substituted` is asserted on **evidence** (blocked font/stylesheet requests, plus FontFaces
the browser reports as failed), never on the mere fact of being in a container. A page that ships no
web fonts loses nothing to a jailed network, and warning it anyway is the same sin as a false
all-clear pointed the other way.

### 11.4 The HAR bridge

The load-bearing piece, and the only thing that makes the two Glassboxes one system:

```
networked machine:  glassbox session open s --record-har run.har  …  glassbox session close s
sandbox:            glassbox session open s --har run.har
```

One artifact fixes three things at once — egress (the requests resolve), fonts (a HAR embeds the
font payloads, so text metrics become real and `font-dependent` findings become portable), and
determinism (same bytes every run). M13 proves it end to end, and proves the part that matters
most: the HAR run **sees a low-contrast defect the jailed run could not see at all**, because the
stylesheet that carried it never loaded. The bridge does not merely silence noise; it restores
findings.

Recording gotchas, both learned the hard way: playwright writes the HAR on **context close**, so a
recording session must be closed cleanly and settled first (an in-flight request records as status
-1 with no body); and **cross-origin fonts are CORS-restricted**, so a third-party font with no
`Access-Control-Allow-Origin` silently never loads and never records.

### 11.5 Lifecycle: what a reaper must never do

`prockit.mjs` is now platform dispatch over `prockit-win32.mjs` and a new `prockit-posix.mjs`
(`/proc`, no subprocesses, works in a stripped image with no procps). Three corrections fell out,
all of the same shape — *a check that cannot look must not report "clean"*:

- Every one of these functions shelled out to `powershell.exe`, so on Linux they returned `[]`. The
  suite's opening `0 precondition clean` and closing `zero strays` checks therefore **passed
  vacuously** while browsers leaked between tests. They now report real counts (18 → 0).
- The stray marker was the bare string `'glassbox'`, on the assumption the state root contains it.
  Point `GLASSBOX_HOME` elsewhere and the reaper matched nothing forever. It now matches the actual
  `chrome-data` path, and daemons match the resolved daemon entry rather than a directory name.
  (This bullet used to add "*which the suite must*, so a run never reaps a developer's live
  sessions." It doesn't. See §11.7.)
- **A zombie is not alive.** `process.kill(pid,0)` succeeds on a zombie, so a killed child reads as
  running; in a container whose PID 1 does not reap, every "is the tree down?" loop spins to its
  timeout and reports a leak that does not exist. `processAlive` now reads the state field.
- **Report what you killed, not what was left.** `kill-all`'s `before` count was sampled just above
  `sweepOrphans()` — after the graceful `/shutdown` had already closed the browser — so the command
  routinely printed `chromium 0 -> 0` on a run that had just taken nine processes down. Every number
  in it was true and the sentence was still misleading, because a reader takes `0 -> 0` to mean
  "there was nothing here." It now samples before the shutdown request. m1's stray check has counted
  independently all along and printed the disagreement in its detail line for weeks, which is an
  argument for putting the raw numbers in a passing check's output and not only in a failing one.

`dev`'s POSIX tree kill was a bare `kill(-pid)`; a `shell:true` grandchild can escape the group, so
it now goes through the same `/proc` walk.

### 11.6 State root

`LOCALAPPDATA || TEMP || '.'` ended in a **relative** path, so the CLI, a daemon spawned with a
different cwd, and the test runner could each compute a different root and then disagree about
where `daemon.json` lives — a discovery file nobody can find is indistinguishable from a dead
daemon. The root is now always absolute: `GLASSBOX_HOME` > platform default > tmp.

### 11.7 The safeguard that existed only in a comment

Found 2026-07-28 while auditing for publish. Three source comments and §11.5 above asserted that the
test suite points `GLASSBOX_HOME` at an isolated root "so a run never reaps a developer's live
sessions." **No test sets `GLASSBOX_HOME`.** Not one of the thirteen. They pass `GLASSBOX_NO_OPEN`
through `env:` and inherit everything else, so the suite runs against the same real state root — and
therefore the same `chrome-data` marker — that a live daemon on that machine is using. Every
milestone opens with `cli(['kill-all'])` as its precondition and closes with one as a safety net.

What actually stands between that and a developer losing live work is **not** the claimed mechanism.
It is the session-ownership guard added in `defects-4`: plain `kill-all` POSTs `/shutdown` with
`{mine:false, force:false}`, and the daemon refuses with `FOREIGN_SESSIONS` when another client's
sessions were used within the last five minutes, which makes `killAll()` return before
`sweepOrphans()` ever runs. So the protection is real, it is just somewhere else entirely, and it
was arrived at for a different reason. The residual hazard is genuine and bounded: a foreign daemon
**idle more than five minutes** is shut down and its sessions destroyed by a test precondition.

Two things worth keeping, both of which rhyme with §11.1:

- A safeguard asserted in a comment is not a safeguard, and unlike a wrong measurement nothing in a
  test run can contradict it — the tests are the thing that would trip it, and they were fine,
  because the mitigation they were relying on was one they never named.
- The reaper's marker was hardened (§11.5) *specifically for* a custom `GLASSBOX_HOME` that nothing
  sets. The hardening is still correct — it matters the moment isolation lands — but it was written
  against an imagined configuration, and imagining a configuration is how you stop checking it.

Not fixed here, deliberately: real isolation means making `PATHS` lazy (it freezes `stateRoot()` at
import, so an ESM test body cannot set the env before the module graph resolves) and then setting
the env in thirteen test files. That is a harness change with a real chance of destabilising a suite
that is green, and it is the wrong week for it. Tracked as issue #2; until it lands, `CONTRIBUTING.md`
says plainly what running the suite will do to a live daemon.

### 11.8 `--mine` was machine-wide whenever it could not see a daemon

Found in the same audit, and unlike §11.7 this one was live. Round 4 (§2, "Ownership") gave the
destroy verbs an owner model, and every part of it lives on the **daemon**: `--mine` POSTs
`/shutdown {mine:true}`, the daemon destroys only the caller's sessions, and if other clients remain
it replies `daemonStopping:false` so the CLI returns before the process-level sweep. That is correct
and tested (m12 `b1`/`b2`).

It only engages when the daemon is reachable. `readDaemonFile()` returning null — a stale discovery
file, a `kill-all` that raced a starting daemon, an orphan — skipped the request entirely and fell
through to `sweepOrphans()`, which matches chromium on the chrome-data marker and knows nothing about
owners. So `--mine` killed every agent's browser on the machine in precisely the case where it had
*less* evidence about ownership, not more.

Measured with m12's fixture (client A holding two live sessions, B calling):

| `kill-all --mine`, discovery file deleted | chromium | A's sessions per `session ls` |
| --- | --- | --- |
| before the fix | **8 → 0** | still reports 2 |
| after the fix | **8 → 8**, `swept:false` | still reports 2 |

The second column is the part worth staring at. The daemon process itself survived, so its session
records survived — `session ls` went on reporting two live sessions whose browser had just been
destroyed underneath them. A list that confidently names sessions that can no longer do anything is
the same failure as a reaper reporting a reassuring zero, one layer up.

The fix is not to make `--mine` inert when the daemon is gone: sweeping your own leaked chromium
after the daemon has already exited *is* the normal end-of-task cleanup, and refusing would leak a
browser per task for the single-agent majority. It asks the question that actually decides it — is
any daemon still alive (`listGlassboxDaemons()`, PID-verified, which already existed for `--force`)?
None alive, nobody can own anything, sweep. One alive that the discovery file does not name, it may
be serving someone right now, so refuse and name `--force`, where machine-wide power already lives
by design (D12). Pinned by m12 `b3`, which reports `chromium 8 -> 0` against every commit before it.

The general shape, and it is the third instance this week: **a guard that lives at one layer does not
protect the paths that bypass that layer.** Ownership was enforced in the daemon; the sweep runs in
the CLI and reaches the OS directly. Nothing about the daemon-side model was wrong. It just wasn't
where the destruction happened.
