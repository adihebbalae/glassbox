# Verification & Debugging Technique Stack for Automated UI Checking

Research pass for Glassbox: a local CDP-owning daemon that gives Claude Code agents
one-call verification bundles (console+network+a11y+layout+screenshots) plus deep
white-box debugging. This document surveys the concrete libraries/APIs for each
technique and the traps that matter for an *agent-driven* workflow (no human in the
loop to eyeball a diff or dismiss a false positive).

---

## 1. Console / pageerror / unhandledrejection capture

Playwright is the reference implementation to copy because it exposes three
distinct, non-overlapping event channels rather than one "errors" bucket:

- `page.on('console', msg => ...)` — every `console.*` call, including framework
  warnings (React's `console.error` for hydration mismatches lands here, not in
  `pageerror`). `msg.type()`, `msg.text()`, `msg.location()`, and `msg.args()` (JSHandles,
  so you can `jsonValue()` them) are all available. [Playwright WebError docs](https://playwright.dev/docs/api/class-weberror)
- `page.on('pageerror', exception => ...)` — uncaught exceptions thrown during
  script execution (`Error` objects with `.message` and `.stack`). This is the
  channel for `unhandledrejection`-class failures too: Playwright's Chromium driver
  listens to CDP `Runtime.exceptionThrown`, which fires for both uncaught throws
  *and* unhandled promise rejections, so a single listener covers both without
  manually attaching a `window.addEventListener('unhandledrejection', ...)` bridge script.
- `browserContext.on('weberror')` — a context-wide superset of `pageerror` that
  works across all pages/popups opened in a session, useful when an agent's action
  opens a new tab and you don't want to have raced-attach a listener on it. [WebError class](https://playwright.dev/docs/api/class-weberror)

As of the Playwright 1.5x line, `page.consoleMessages()` and `page.pageErrors()`
exist as buffered accessors (with a `predicate` filter) so an agent doesn't have to
pre-attach listeners before the action it wants to observe — it can run the
action, then pull everything that happened. This matters a lot for a "verify after
the fact" tool design instead of "instrument before every call." [Release notes](https://playwright.dev/docs/release-notes)

**Known gap**: several GitHub issues report `pageerror` not firing for errors
thrown inside iframes or for `worker` contexts — Playwright's issue tracker has
open bugs here (#16648, #2280). A completeness-minded capture layer should also
subscribe per-frame (`frame.on(...)` isn't a thing, but `page.on('frameattached')`
+ per-frame CDP session) and per-worker (`page.on('worker')` → attach console
listeners on the `Worker` object) rather than assuming page-level listeners are
transitively complete. [Issue #16648](https://github.com/microsoft/playwright/issues/16648), [Issue #2280](https://github.com/microsoft/playwright-python/issues/2280)

**Design implication**: capture at the `browserContext` level by default (not
`page`), buffer everything with timestamps + source location, and expose both a
raw stream and a deduped/grouped summary (identical stack trace = 1 entry + count),
because a broken effect that re-renders in a loop can emit hundreds of identical
`console.error` lines that would otherwise flood an agent's context window.

---

## 2. Network failure detection

Playwright/CDP split "network failure" into two non-overlapping event types, and
conflating them is the #1 source of false negatives in ad hoc scripts:

- **`page.on('requestfailed')`** — true network-layer failures: DNS failure,
  connection refused, TLS failure, **CORS preflight/opaque-response block**, or a
  request that was `net::ERR_ABORTED`. `request.failure()?.errorText` gives the
  Chromium net-error string (e.g. `net::ERR_BLOCKED_BY_CLIENT`,
  `net::ERR_CONNECTION_REFUSED`). CORS violations show up here with a
  `CORSErrorStatus` field surfaced from CDP's `Network.loadingFailed`.
- **`page.on('response')`** — fires for *any* completed HTTP exchange, including
  4xx/5xx. An HTTP 404 or 500 is "successful" at the transport level, so it will
  **not** trigger `requestfailed` — you must inspect `response.status()` yourself.
  This is a well-documented gotcha (Playwright issue #29170: "response is not
  emitted when response... is not 200 status code?" — it is emitted, just not
  where people expect). [Request class](https://playwright.dev/docs/api/class-request)

**Mixed content**: Chromium blocks or auto-upgrades http:// subresources on https://
pages; blocked mixed-content requests surface as `requestfailed` with
`net::ERR_BLOCKED_BY_CLIENT` or as a `console` warning
(`Mixed Content: The page at ... was loaded over HTTPS, but requested an insecure ...`).
Because it's a console warning as often as a network error, a robust detector
should grep `console` messages for the string `Mixed Content` in addition to
watching network events.

**Hanging requests**: neither Playwright nor raw CDP has a "this request is stuck"
event — you have to build it: record `requestWillBeSent`/`page.on('request')`
timestamps, and on your own quiescence timeout (see §9) diff the set of in-flight
`request` objects against `requestfinished`/`requestfailed` completions. A request
present in the first set and absent from both completion sets after N seconds is
"hanging." CDP's `Network.loadingFailed` carries a `canceled` boolean that
distinguishes a canceled request (e.g. navigated away) from a genuine stall.
[network package docs](https://pkg.go.dev/github.com/mafredri/cdp/protocol/network)

**Design implication**: a `networkSummary()` bundle output should bucket into
`{failed: [...], httpError: [...], mixedContent: [...], hanging: [...]}` rather
than a flat list — an agent asking "did anything break" needs the taxonomy, not a
log dump it has to re-derive.

---

## 3. Accessibility audits

**axe-core** is the de facto engine — it's what Lighthouse, Playwright's own
`@axe-core/playwright`, Cypress's `cypress-axe`, and most commercial scanners
(Deque axe DevTools) all wrap. [axe-core GitHub](https://github.com/dequelabs/axe-core)

- **Injection**: `@axe-core/playwright`'s `AxeBuilder` handles injection
  automatically — no manual `injectAxe()` step (unlike the Cypress plugin, which
  requires you to call it explicitly per test). [QA Madness guide](https://www.qamadness.com/a-you-oriented-guide-to-axe-core-playwright-accessibility-testing/)
- **Scoping to reduce noise**: `AxeBuilder.include(selector)` / `.exclude(selector)`
  restrict the scan to the region under test — this is the primary noise-reduction
  lever, since a full-page scan on a component library re-flags the same nav/footer
  violations on every check. [dev.to guide](https://dev.to/vitalyskadorva/accessible-web-testing-with-playwright-and-axe-core-2kg1)
- **Cost**: axe-core historically had a severe performance cliff on large DOMs —
  the `color-contrast` rule alone took **26 seconds on MLB.com** before Deque
  optimized it with a 2D spatial grid (memory cost: 5.5MB → 12.3MB per run, traded
  for dropping large-page runtime to ~5 seconds even on 50k+ node pages). This is
  the rule to budget for; if an agent tool runs axe-core on every verification
  call, color-contrast is where the wall-clock goes. [Steven Lambert writeup](https://stevenklambert.com/writing/axe-core-color-contrast-performance/)
- **Dedup**: axe-core itself does not dedupe across runs/pages — that's left to
  the caller or to paid tooling (Deque's axe DevTools Pro does "AI-paired triage"
  dedup across pages). For a local tool, dedup by `(ruleId, target-selector-pattern)`
  is a reasonable cheap heuristic — same rule firing on structurally identical
  repeated elements (e.g. a card grid) should collapse to one finding with a count.
- **Ceiling**: automated tools including axe/Lighthouse only catch an estimated
  **20–40% of WCAG violations** — the rest need a human or a screen-reader pass.
  Frame axe-core output as "no automated violations found," never "accessible."
  [AccessProof](https://access-proof.com/blog/what-is-axe-core-evidence-based-audits)

**Lighthouse's approach**: Lighthouse's a11y category literally runs axe-core
under the hood (`lighthouse-core/audits/accessibility/axe-audit.js` wraps each
axe rule as an "audit") but on a **curated subset** of rules, then reports a
weighted percentage score rather than a raw violation list. If Glassbox wants a
single 0–100 signal for regression-gating, mirroring Lighthouse's weighting is
reasonable; if it wants actionable findings, go straight to axe-core with the full
ruleset and skip Lighthouse's scoring layer entirely (Lighthouse also drags in
performance/SEO categories you don't want for a UI-verification tool).
[Lighthouse axe-audit.js](https://paulirish.github.io/lighthouse/docs/api/lighthouse/2.5.1/lighthouse-core_audits_accessibility_axe-audit.js.html), [DebugBear](https://www.debugbear.com/blog/lighthouse-accessibility)

Chromium's CDP also exposes `Accessibility.getFullAXTree`, the raw accessibility
tree the browser itself computes — this is a lower-level, framework-agnostic
alternative/supplement to axe-core's DOM-heuristic ruleset (it's what Puppeteer's
`page.accessibility.snapshot()` wraps) and is worth using for "is this element
exposed to a screen reader at all" checks that axe's rule-based approach doesn't
directly answer.

---

## 4. Visual regression

**Diff engines**, roughly fastest→slowest / most→least structure-aware:

| Library | Approach | Notes |
|---|---|---|
| pixelmatch | pixel-level, ~150 LOC, zero deps, perceptual color-distance (not naive RGB delta) | The baseline everyone benchmarks against; used inside Playwright's own `toHaveScreenshot`. [GitHub](https://github.com/mapbox/pixelmatch) |
| odiff | SIMD (SSE2/AVX2/AVX512/NEON) Zig rewrite, ~8× faster than pixelmatch | Good drop-in when pixelmatch is the bottleneck in a large suite. [GitHub](https://github.com/dmtrKovalenko/odiff) |
| BlazeDiff / Honeydiff | Rust+JS cores, 3–8× faster than odiff on 4K images | A 200-screenshot suite: odiff ≈48s pure-diff time vs Honeydiff ≈4s. Newest entrants (2026), smaller ecosystem. [Vizzly benchmark](https://vizzly.dev/blog/honeydiff-vs-odiff-pixelmatch-benchmarks/) |
| resemble.js | Pixel-level, older, inspired pixelmatch | Largely superseded; cite for lineage only. |
| SSIM (BlazeDiff's ssim API, others) | Structural-similarity window comparison — luminance/contrast/structure, not per-pixel | Correctly scores a 4px navbar shift or font-rendering variance as "unchanged" (SSIM ≈0.998) where pixelmatch would flag every pixel below the shift as diffed. **This is the fix for the single biggest false-positive source in pixel-diffing: sub-pixel font AA and anti-aliasing rendering differences across OS/GPU.** [BlazeDiff SSIM docs](https://www.blazediff.dev/apis/ssim), [algorithm comparison gist](https://gist.github.com/Mathspy/351b0e74669482abcdd9477bc933c1dd) |

**Baseline management for an agent workflow** (this is the harder problem than the
diff algorithm):
- Never let CI/an agent auto-run `--update-snapshots` unsupervised — treat baseline
  updates as a reviewable diff, committed in the same change as the UI edit so a
  human/agent reviewer sees "here's the intentional visual change" side by side
  with the code diff. [TestQuality guide](https://testquality.com/playwright-visual-regression-guide/)
- **Docker-pin the renderer.** Cross-OS font/subpixel-AA differences are the
  single highest-flake source in screenshot diffing; running the official
  `mcr.microsoft.com/playwright:vX-noble` image both for baseline capture and for
  comparison eliminates most of it. An agent-local tool controlling its own
  Chromium via CDP should pin the exact Chromium build/flags for the same reason.
  [BrowserStack guide](https://www.browserstack.com/guide/playwright-snapshot-testing)
- Prefer **component/region-level snapshots over full-page** — smaller blast
  radius, and a diff report that says "the pricing card changed" is far more
  actionable to an agent (or a human) than "1,140 pixels differ somewhere on this
  1400px-tall page."
- For an agent that runs verification dozens of times per session (not just at
  commit boundaries), consider a **two-tier baseline**: an ephemeral
  "last-observed" screenshot per session for quick self-diffing during iterative
  fixing, and a separate, explicitly-promoted "golden" baseline that only updates
  on human/agent-confirmed intentional changes — this avoids baseline drift from
  transient work-in-progress states poisoning the real regression baseline.

---

## 5. Layout pathology detection (deep dive)

This is where Glassbox has to write its own instrumentation script — no single
library covers this whole surface. Each sub-check below is a DOM-evaluate snippet
Playwright/CDP can `Runtime.evaluate` on demand:

**Horizontal overflow.** `el.scrollWidth > el.clientWidth` is the canonical test
(both exclude margin/border; `scrollWidth` includes overflowed content,
`clientWidth` doesn't). For "is the whole page horizontally scrollable" (the most
common mobile-layout bug), test `document.documentElement.scrollWidth >
document.documentElement.clientWidth`. A robustness note from the literature:
some elements report false overflow due to `overflow` computed style; temporarily
forcing `overflow: hidden`, measuring, then restoring gives a cleaner signal.
[MDN scrollWidth](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollWidth), [detection writeup](https://davidwalsh.name/detect-overflow-elements)

**Element overlap / occlusion.** `document.elementFromPoint(x, y)` returns only
the topmost hit-target at a point — exactly the primitive Playwright's own
"Receives Events" actionability check uses internally (§9). To detect "element A
is supposed to be clickable but element B covers it," compute A's
`getBoundingClientRect()` center (or corners, for partial-occlusion detection),
call `elementFromPoint` there, and check whether the returned node is A or a
descendant of A. To enumerate *all* stacked elements at a point (for full overlap
graphs, not just top-hit), repeatedly hide the returned element
(`style.visibility='hidden'`) and re-query, then restore — a documented but
expensive workaround since the API only exposes the topmost node. [MDN/overlap workaround](https://www.xjavascript.com/blog/get-element-from-point-when-you-have-overlapping-elements/)

**Zero-size click targets.** Combine `getBoundingClientRect()` (width/height ≤0 or
sub-threshold, e.g. <24×24px per WCAG 2.5.5/2.5.8 target-size guidance) with a
check that the element is otherwise "should be interactive" (has a click handler,
is a link/button/input, or has `role="button"`/`cursor: pointer`). This is a case
where Playwright's own "Visible" actionability definition is directly reusable:
"non-empty bounding box and not `visibility:hidden`" — zero-size elements
explicitly fail this. [Playwright actionability.md](https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/docs/src/actionability.md)

**Text contrast / white-on-white.** Don't hand-roll the WCAG relative-luminance
math — axe-core's `color-contrast` rule already does the hard part (resolving
*effective* background color through stacked transparent/semi-transparent
ancestors, which is the actual difficulty, not the contrast formula itself). If a
standalone contrast check is wanted outside axe, small libraries like
`get-contrast` or `wcag-contrast` implement the WCAG 2.x luminance-ratio formula
(L1/L2, ISO-9241-3 based) directly from resolved `rgb()`/`hex` pairs — but they
still require you to resolve "effective background" yourself, which is why
piggybacking on axe-core for this specific check is usually the pragmatic choice.
[npm wcag-contrast](https://www.npmjs.com/package/wcag-contrast), [get-contrast](https://www.npmjs.com/package/get-contrast)

**Offscreen content.** Two distinct failure modes to separate: (a) intentionally
offscreen (`position:absolute; left:-9999px`) — a legitimate a11y pattern, not a
bug; (b) unintentionally offscreen (element rendered past viewport/container
bounds due to a layout bug — e.g. `getBoundingClientRect()` shows `right >
viewport.innerWidth` for an element that should be in-flow). Distinguish by
checking `overflow` on ancestors and whether the element has
`clip`/`clip-path`/screen-reader-only sizing (1px, `overflow:hidden`) as the
deliberate-offscreen signature vs. a bare positional escape.

**Broken images.** `img.complete === true && img.naturalWidth === 0` (or
`naturalHeight === 0`) is the standard signature of a failed image load — before
load completes both are legitimately 0, so you must also gate on `.complete`.
Enumerate `document.querySelectorAll('img')`, filter, collect `.src`. Playwright
write-ups confirm this exact pattern as the accepted check. [detection writeup](https://keith.gaughan.ie/detecting-broken-images-js.html), [Playwright practice](https://www.tjmaher.com/2026/05/practicing-playwright-how-to-detect.html)

**Invisible-but-present elements.** The modern, single-call answer is
`Element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true,
contentVisibilityAuto: true })` — widely available since March 2024 in Chromium,
so safe to rely on for a Chromium-only local tool. It subsumes manually checking
`display:none`, `visibility:hidden`, `opacity:0`, and `content-visibility:hidden`/`auto`-skipped
rendering in one call, which is strictly better than the old pattern of
hand-checking `getComputedStyle()` fields (which misses `content-visibility` and
is easy to get subtly wrong on inherited `visibility`). Note the default
`checkVisibility()` (no options) does *not* check opacity or CSS visibility — you
must opt in per-flag. [MDN checkVisibility](https://developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility)

**CLS during load.** The Layout Instability API
(`new PerformanceObserver(cb).observe({type:'layout-shift', buffered:true})`) is
the ground truth — Chromium-only, reports each shift's `value` (impact fraction ×
distance fraction) plus `hadRecentInput` (filter these out; they're
user-caused, not layout bugs). `buffered:true` on observer creation retroactively
delivers shifts that happened before the observer attached, which matters because
an agent's verification script typically attaches *after* navigation starts, not
before. Sum non-input-caused `value`s for a CLS score; **individual entries with
large single `value`s plus their `sources` array (which DOM nodes moved) are more
actionable for an agent than the aggregate score** — the aggregate says "layout
shifted," the entry sources say "this specific banner pushed content down."
[web.dev debug guide](https://web.dev/articles/debug-layout-shifts), [Layout Instability spec](https://wicg.github.io/layout-instability/)

---

## 6. Responsive sweeps

There's no single canonical breakpoint list, but the 2026 literature converges on
a practical sweep set: **360/375/390/414/430px** (mobile — covers small-Android
through iPhone Pro Max widths), **768px** (tablet portrait / the classic
Bootstrap/iPad breakpoint, sometimes tested to 850px for newer tablets), **1024px**
(tablet landscape / small laptop), **1280–1440px** (standard desktop), **1920px**
(large desktop). A minimal but representative agent-default sweep: `[375, 768,
1024, 1440]` — narrow enough to catch the two most-common real bug classes
(mobile horizontal overflow, tablet-breakpoint layout collapse) without an
expensive N-viewport matrix on every verification call. [Framer breakpoints guide](https://www.framer.com/blog/responsive-breakpoints/), [BrowserStack](https://www.browserstack.com/guide/responsive-design-breakpoints)

Caveat repeated across sources: DevTools/CDP viewport emulation (`Emulation.setDeviceMetricsOverride`,
what Playwright's `page.setViewportSize`/device descriptors wrap) doesn't perfectly
match real-device rendering (font metrics, scrollbar presence, OS UI chrome) —
acceptable for an automated first pass, but worth flagging to the calling agent
that emulated-viewport findings are a proxy, not a guarantee.

---

## 7. Theme sweeps

Playwright's `colorScheme` context/test option (`'light'`/`'dark'`) or
`page.emulateMedia({ colorScheme: 'dark' })` mid-test directly drives the
`prefers-color-scheme` CSS media feature at the browser level — this is the
correct lever for sites that theme purely via `@media (prefers-color-scheme: dark)`.
[Playwright TestOptions](https://playwright.dev/docs/api/class-testoptions)

It does **not** flip a `data-theme="dark"` attribute or a `.dark` class that a
site's own JS sets (common pattern: a toggle button writes `localStorage` +
`document.documentElement.dataset.theme`, and CSS keys off `:root[data-theme="dark"]`
rather than the media query directly — this is exactly WCII's own convention per
its Artifact tooling). For those sites, `emulateMedia` is necessary but not
sufficient: the sweep must *also* directly set the attribute/class via
`page.evaluate(() => document.documentElement.setAttribute('data-theme','dark'))`
(or click the actual toggle control, which is the higher-fidelity check since it
also exercises the toggle's own JS). A thorough theme-sweep tool should do both —
emulate the OS preference *and* independently force the site's own theme attribute
— because a common real bug is a site that reads `prefers-color-scheme` on first
paint but never re-applies it if a stale `data-theme` was already persisted in
`localStorage` from a previous session.

---

## 8. Font loading failures

`document.fonts.ready` (the Font Loading API, `document.fonts` is a
`FontFaceSet`) returns a Promise that resolves once all `@font-face` fonts
referenced by rendered content have finished loading (or definitively failed)
— this is the right primitive to await before a layout/visual-regression
screenshot, otherwise you risk capturing a FOUT/FOIT transitional state.
[web.dev webfont guide](https://web.dev/articles/optimize-webfont-loading)

`font-display` governs the *visible* failure behavior an agent should be checking
for: `block` gives an invisible-text period (FOIT) before falling back — a page
verified mid-block-period looks like missing text, which is a real regression to
catch, not a flake to ignore; `swap` shows fallback-font text immediately and
swaps when ready (lower visual-fidelity risk, higher CLS risk if metrics differ);
`fallback`/`optional` cap or skip the swap. Per-`FontFace` objects also expose a
`.status` field (`'unloaded'|'loading'|'loaded'|'error'`) — iterating
`[...document.fonts].filter(f => f.status === 'error')` directly surfaces which
specific declared fonts failed to fetch/parse, which is more actionable than the
aggregate `document.fonts.ready` signal (which just tells you "done," not "done
with failures"). [Chrome font-display docs](https://developer.chrome.com/blog/font-display), [MDN font-display](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-display)

---

## 9. Waiting / quiescence

**Playwright's actionability checks** (the exact spec, from `docs/src/actionability.md`):

| Check | Definition |
|---|---|
| Visible | Non-empty bounding box, not `visibility:hidden`. Zero-size / `display:none` fail; `opacity:0` still counts as visible. |
| Stable | Same bounding box across ≥2 consecutive animation frames — this is Playwright's actual anti-CLS-flake mechanism baked into every interaction. |
| Receives Events | Element is the hit-target at the action point (i.e., not occluded) — same primitive as the overlap-detection technique in §5. |
| Enabled | Not `disabled`, not inside a `disabled` fieldset, no `aria-disabled="true"`. |
| Editable | Enabled AND not `readonly`/`aria-readonly="true"`. |

Different actions require different subsets — `click`/`check`/`tap` require
Visible+Stable+ReceivesEvents+Enabled; `hover`/`dragTo` skip Enabled; `fill`/`clear`
require Visible+Enabled+Editable but not Stable/ReceivesEvents; `screenshot`
requires only Visible+Stable. [Playwright actionability.md](https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/docs/src/actionability.md)

**Why `networkidle` was deprecated/discouraged**: it waits for ≥500ms with zero
in-flight network connections. Modern apps essentially never reach true zero —
analytics beacons, WebSocket/SSE connections, background polling, and service
workers keep the network "busy" indefinitely, so `networkidle` either hangs to
timeout or fires arbitrarily early/late depending on unrelated background
traffic. The community-converged replacement is **application-visible readiness
signals**: wait for a specific selector to appear/be stable, or for a specific API
response, rather than a network-quantity heuristic. [Medium writeup](https://medium.com/@gunashekarr11/why-top-automation-teams-avoid-networkidle-and-what-they-use-instead-c0d1e9439dc4), [WebCrawlerAPI glossary](https://webcrawlerapi.com/glossary/playwright/how-to-fix-playwright-networkidle-misuse)

**rAF/MutationObserver quiescence**: the general-purpose pattern for "has the DOM
settled" without app-specific hooks is: attach a `MutationObserver` on
`document.body` (subtree:true, childList/attributes/characterData), reset a debounce
timer on every mutation batch (observer callbacks fire once per microtask/task
batch, not per individual mutation), and separately chain `requestAnimationFrame`
calls to confirm the *rendering* pipeline (not just the DOM tree) has stopped
producing new frames — MutationObserver alone can miss purely-visual settling
(CSS transitions/animations with no DOM mutation). Combining both — "no
mutations for N ms AND N consecutive rAFs produce no bounding-box change on
tracked elements" — is a decent generic quiescence heuristic when there's no
app-specific "ready" signal to hook. [dom-mutations library](https://github.com/sindresorhus/dom-mutations)

**Hydration detection, React**: no universal DOM signal; common practical
approaches are (a) polling for a known post-hydration side-effect (a data
attribute the app itself sets, or an event listener becoming responsive — click
and check for a state change), or (b) the bippy/React-internals route (§10) to
directly ask the fiber tree whether a given root has committed. React itself
doesn't strip a "not yet hydrated" marker from the DOM the way Astro does (below),
so React-only pages are harder to auto-detect hydration-complete on without
app cooperation.

**Hydration detection, Astro islands**: cleaner signal — Astro wraps each
client-hydrated component in a custom `<astro-island>` element carrying an `ssr`
attribute during server render; that attribute is removed once client-side
hydration for that island completes. Polling for the *absence* of `ssr` on all
`astro-island` elements (or the specific one under test) is a direct,
framework-provided readiness check, no internals-hacking required. The
`vitest-browser-astro` package's `waitForHydration()` helper formalizes exactly
this pattern. [GitHub issue on hydration](https://github.com/withastro/astro/issues/9473), [vitest-browser-astro](https://github.com/ascorbic/vitest-browser-astro/)

---

## 10. White-box debugging

**Source maps in Node** (mapping minified/compiled stack traces back to
TS/JSX): `source-map-support` (Evan Wallace) is the long-standing approach —
`require('source-map-support/register')` (or `node -r source-map-support/register`)
patches V8's `Error.prepareStackTrace` to rewrite frames using the `.map` files
adjacent to the compiled output. Purpose-built one-shot parsers like
`stack-source-mapper` / `sourcemapped-stacktrace` exist for the case where you
already have a raw stack string (e.g. captured from a browser `pageerror` event
over CDP, not thrown natively in the Node process) and just need to remap it
against a known source-map file — this is the relevant path for Glassbox, since
the errors originate in Chromium (via `page.on('pageerror')`), not in the Node
daemon process itself, so the daemon needs to fetch the page's sourcemaps
(usually `//# sourceMappingURL=` comment or a `.map` sibling) and remap
browser-side stacks server-side before showing them to the agent. Node itself has
gained *some* native sourcemap support for its own stack traces (nodejs/node#29564,
#51853) but that's for Node-side errors, not a substitute for remapping
browser-side exceptions. [node-source-map-support](https://github.com/evanw/node-source-map-support), [stack-source-mapper](https://www.npmjs.com/package/stack-source-mapper)

**JS coverage → "this handler never ran"**: `page.coverage.startJSCoverage()` /
`.stopJSCoverage()` wraps Chromium's native V8 coverage (CDP `Profiler` domain),
Chromium-only. Output is per-script `functions[]` arrays, each with `ranges` of
`{startOffset, endOffset, count}` — **`count === 0` on a function's top-level
range is the direct, literal "this function/handler never executed" signal**,
exactly the primitive needed for "verify this onClick actually ran" debugging.
Raw V8 coverage format isn't directly source-mapped or human-readable; the
`v8-to-istanbul` library converts it to the standard Istanbul coverage format
(which then combines with the source-map step above to report against original
TS/JSX line numbers, not compiled output). [Playwright Coverage class](https://playwright.dev/docs/api/class-coverage), [BrowserStack guide](https://www.browserstack.com/guide/playwright-coverage)

**React fiber inspection via CDP / bippy**: React communicates with DevTools
through a well-known global hook, `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`, which
React's own bundle checks for and calls into (`onCommitFiberRoot`,
`onPostCommitFiberRoot`, `onCommitFiberUnmount`) on every render/commit/unmount —
this hook is the *only* attach point; there's no separate "React DevTools
protocol" wire format for a headless consumer to speak. Two ways to consume it:
- **`react-devtools-core`** (the real DevTools backend package) — `connectToDevTools({host, port})`
  opens a WebSocket-based bridge to a running DevTools frontend (usually
  `react-devtools` standalone Electron app or the browser extension); this is
  the "attach an actual DevTools UI, even headless" path, but it needs a
  DevTools *frontend* on the other end of the socket to be useful — it's a
  protocol built for a human-facing UI, not for an agent to query directly. Must
  be initialized before React itself loads (patches the hook first). [Snyk advisor](https://snyk.io/advisor/npm-package/react-devtools-core/functions/react-devtools-core.connectToDevTools)
- **bippy** (`aidenybai/bippy`) — the more directly useful primitive for an
  agent tool: it monkey-patches the same global hook itself (no real DevTools
  frontend needed) and exposes `instrument()` to subscribe to commits, plus
  `traverseFiber()` / `traverseRenderedFibers()` to walk the tree and
  `traverseProps()`/`traverseState()`/`traverseContexts()` to pull out
  component state without any React source cooperation. It also exposes
  `overrideProps()`/`overrideHookState()`/`overrideContext()` for **write**
  access — i.e., an agent could not just inspect but forcibly set a component's
  state/props for a debugging probe. Explicitly labeled "hack into react
  internals," version-fragile by nature (README warns it "may break production
  apps... uses react internals, which can change at any time"), development-only
  posture recommended. This is the library `react-scan` is built on. [bippy README](https://github.com/aidenybai/bippy/blob/main/README.md)

**Vue equivalent**: `@vue/devtools-kit` is the modern (v7+/v8) programmatic
counterpart to `react-devtools-core` — it's the actual package the Vue DevTools
browser extension and standalone app are built on, so in principle it exposes the
same "component tree, state, computed, events" surface, but detailed programmatic
(non-UI, headless-consumption) API documentation is thin outside its own
source/README — treat as "confirmed to exist and actively maintained (v8.1.2 as
of this research, 25 days old at time of search)" rather than "documented for
this exact headless-CDP use case." The Vue **plugin API** (`app.config.globalProperties.__VUE_DEVTOOLS_GLOBAL_HOOK__`
pattern, analogous to React's global hook) is the more likely stable attach point
for a bippy-style unofficial approach if `devtools-kit`'s official surface proves
too UI-coupled. [@vue/devtools-kit npm](https://www.npmjs.com/package/@vue/devtools-kit), [Plugin API](https://devtools.vuejs.org/plugins/api)

---

## Design implications summary

- Attach console/error/network listeners at **`browserContext`** scope, not
  `page`, and buffer with a query/predicate API (mirrors Playwright's own
  `consoleMessages()`/`pageErrors()`) so agents don't have to pre-instrument
  before every action — "run, then ask what happened" fits the verification-bundle
  model better than "instrument, then run."
- Network summaries need a **taxonomy** (`failed` / `httpError` / `mixedContent` /
  `hanging`), not a flat event log — `requestfailed` and 4xx/5xx `response` are
  genuinely different failure classes that a naive listener conflates.
- Budget axe-core's `color-contrast` rule specifically; scope scans with
  `include`/`exclude` by default rather than always full-page, and dedupe
  structurally-identical repeated violations before returning to the agent.
- For visual regression, default to **SSIM or a perceptual-diff tolerance**, not
  raw pixelmatch, to avoid font-AA/subpixel false positives across runs on the
  same machine — and pin the exact Chromium build the daemon owns (already true
  by Glassbox's design) so cross-run rendering is at least self-consistent even
  without SSIM.
- Layout-pathology checks are all cheap, synchronous, Chromium-only DOM snippets
  (`checkVisibility()`, `elementFromPoint`, `scrollWidth`/`clientWidth`,
  `PerformanceObserver({type:'layout-shift'})`, `naturalWidth`) — bundle them into
  one `Runtime.evaluate` payload per verification call rather than N round-trips.
- Theme sweeps must drive **both** `emulateMedia({colorScheme})` and the site's
  own `data-theme`/class mechanism independently — one does not imply the other.
- Quiescence should default to an app-agnostic MutationObserver+rAF debounce
  heuristic, with an escape hatch for callers to supply an app-specific
  readiness selector (Astro's `astro-island[ssr]` absence is a concrete,
  reusable example of what that escape hatch should support out of the box).
- White-box React/Vue inspection is real and buildable (bippy proves the pattern)
  but is inherently version-fragile internals-hacking — gate it behind an
  explicit opt-in flag, never make it a default part of the verification bundle,
  and expect to maintain per-major-version compatibility shims.

---

## Sources

- [Playwright — WebError class](https://playwright.dev/docs/api/class-weberror)
- [Playwright — release notes (consoleMessages/pageErrors)](https://playwright.dev/docs/release-notes)
- [Playwright issue #16648 — can't capture pageerror in some contexts](https://github.com/microsoft/playwright/issues/16648)
- [Playwright-python issue #2280 — console/pageerror capture bug](https://github.com/microsoft/playwright-python/issues/2280)
- [Playwright — Request class docs](https://playwright.dev/docs/api/class-request)
- [Playwright issue #29170 — response event and non-200 status](https://github.com/microsoft/playwright/issues/29170)
- [mafredri/cdp Network protocol package (Go) — loadingFailed fields](https://pkg.go.dev/github.com/mafredri/cdp/protocol/network)
- [axe-core (dequelabs) GitHub](https://github.com/dequelabs/axe-core)
- [QA Madness — Axe-Core Playwright accessibility guide](https://www.qamadness.com/a-you-oriented-guide-to-axe-core-playwright-accessibility-testing/)
- [dev.to — Accessible web testing with Playwright and Axe Core](https://dev.to/vitalyskadorva/accessible-web-testing-with-playwright-and-axe-core-2kg1)
- [Steven Lambert — Improving Axe-core color-contrast performance](https://stevenklambert.com/writing/axe-core-color-contrast-performance/)
- [AccessProof — what axe-core is and its coverage ceiling](https://access-proof.com/blog/what-is-axe-core-evidence-based-audits)
- [Lighthouse source — axe-audit.js](https://paulirish.github.io/lighthouse/docs/api/lighthouse/2.5.1/lighthouse-core_audits_accessibility_axe-audit.js.html)
- [DebugBear — Understanding Lighthouse accessibility audit reports](https://www.debugbear.com/blog/lighthouse-accessibility)
- [mapbox/pixelmatch GitHub](https://github.com/mapbox/pixelmatch)
- [dmtrKovalenko/odiff GitHub](https://github.com/dmtrKovalenko/odiff)
- [Vizzly — Honeydiff vs odiff vs pixelmatch benchmarks](https://vizzly.dev/blog/honeydiff-vs-odiff-pixelmatch-benchmarks/)
- [BlazeDiff — SSIM API docs](https://www.blazediff.dev/apis/ssim)
- [Gist — visual diffing algorithms comparison](https://gist.github.com/Mathspy/351b0e74669482abcdd9477bc933c1dd)
- [TestQuality — Playwright visual regression baselines/flake/CI guide 2026](https://testquality.com/playwright-visual-regression-guide/)
- [BrowserStack — Playwright snapshot testing guide 2026](https://www.browserstack.com/guide/playwright-snapshot-testing)
- [MDN — Element.scrollWidth](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollWidth)
- [David Walsh — Detect CSS overflow elements](https://davidwalsh.name/detect-overflow-elements)
- [xjavascript.com — elementFromPoint with overlapping elements](https://www.xjavascript.com/blog/get-element-from-point-when-you-have-overlapping-elements/)
- [MDN — Element.checkVisibility()](https://developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility)
- [npm — wcag-contrast](https://www.npmjs.com/package/wcag-contrast)
- [npm — get-contrast](https://www.npmjs.com/package/get-contrast)
- [Keith Gaughan — Detecting broken images with JavaScript](https://keith.gaughan.ie/detecting-broken-images-js.html)
- [tjmaher.com — Practicing Playwright: detect broken images](https://www.tjmaher.com/2026/05/practicing-playwright-how-to-detect.html)
- [web.dev — Debug layout shifts](https://web.dev/articles/debug-layout-shifts)
- [WICG — Layout Instability API spec](https://wicg.github.io/layout-instability/)
- [Framer — Breakpoints in responsive web design, 2026 guide](https://www.framer.com/blog/responsive-breakpoints/)
- [BrowserStack — Responsive design breakpoints guide](https://www.browserstack.com/guide/responsive-design-breakpoints)
- [Playwright — TestOptions (colorScheme)](https://playwright.dev/docs/api/class-testoptions)
- [web.dev — Optimize webfont loading and rendering](https://web.dev/articles/optimize-webfont-loading)
- [Chrome for Developers — Controlling font performance with font-display](https://developer.chrome.com/blog/font-display)
- [MDN — @font-face font-display](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-display)
- [Playwright — actionability.md (raw, main branch)](https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/docs/src/actionability.md)
- [Medium — Why top automation teams avoid networkidle](https://medium.com/@gunashekarr11/why-top-automation-teams-avoid-networkidle-and-what-they-use-instead-c0d1e9439dc4)
- [WebCrawlerAPI glossary — fixing networkidle misuse](https://webcrawlerapi.com/glossary/playwright/how-to-fix-playwright-networkidle-misuse)
- [sindresorhus/dom-mutations GitHub](https://github.com/sindresorhus/dom-mutations)
- [withastro/astro issue #9473 — hydration error discussion / astro-island behavior](https://github.com/withastro/astro/issues/9473)
- [ascorbic/vitest-browser-astro GitHub](https://github.com/ascorbic/vitest-browser-astro/)
- [evanw/node-source-map-support GitHub](https://github.com/evanw/node-source-map-support)
- [npm — stack-source-mapper](https://www.npmjs.com/package/stack-source-mapper)
- [Playwright — Coverage class docs](https://playwright.dev/docs/api/class-coverage)
- [BrowserStack — Code coverage for Playwright guide](https://www.browserstack.com/guide/playwright-coverage)
- [aidenybai/bippy README (GitHub)](https://github.com/aidenybai/bippy/blob/main/README.md)
- [Snyk Advisor — react-devtools-core.connectToDevTools usage](https://snyk.io/advisor/npm-package/react-devtools-core/functions/react-devtools-core.connectToDevTools)
- [npm — @vue/devtools-kit](https://www.npmjs.com/package/@vue/devtools-kit)
- [Vue DevTools — Plugins API](https://devtools.vuejs.org/plugins/api)
