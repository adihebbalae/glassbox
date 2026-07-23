# CDP Capability Audit for an Instrumented Agent Browser (Glassbox)

Research date: July 2026. Scope: audit Chrome DevTools Protocol domains against Glassbox's
core hypotheses — daemon-owned Chromium, named parallel isolated sessions, MCP+CLI, one-call
verification bundles, white-box debugging, human ride-along, disk artifacts.

## 0. Headline finding: the gap Glassbox would fill is real, not hypothetical

The two most-used 2026 "AI agent browser" tools both have **open, unresolved issues asking for
exactly the capability that is Glassbox's first hypothesis** (named parallel isolated sessions):

- `ChromeDevTools/chrome-devtools-mcp` (Google's own official MCP server) — issue #926,
  "Feature request: Multi-session support for parallel browser instances." As of the fetch,
  "the current MCP server binds to a single Chrome instance for its entire lifetime." No
  maintainer commentary; a PR (#899) exists but isn't merged/confirmed.
  https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/926
- `vercel-labs/agent-browser` (Rust CLI+daemon, MCP+CLI, closest architectural sibling to
  Glassbox) — issue #1068, "CDP BrowserContext support for cookie-isolated parallel
  sessions." Direct quote: "All sessions share the default BrowserContext, meaning cookies,
  localStorage, and sessionStorage leak between sessions." The issue author's own comparison
  table shows why `Target.createBrowserContext` (1 window, 1 process, ~5ms) is strictly better
  than spinning up N separate `--profile` Chrome processes (N windows, N processes, slow).
  https://github.com/vercel-labs/agent-browser/issues/1068

agent-browser is worth treating as prior art/competitor throughout: Rust daemon over raw CDP
(no Node dependency), persistent daemon with idle-timeout auto-shutdown, ref-based element
selection (`@e1`), MCP server with tool "profiles" (network/state/debug/tabs/react/mobile),
`Page.startScreencast`-based live streaming already shipped (see §11 for its own bug reports
on that path). https://github.com/vercel-labs/agent-browser

## 1. Target + BrowserContext — parallel isolated sessions

Methods: `Target.createBrowserContext`, `Target.disposeBrowserContext`,
`Target.getBrowserContexts`, `Target.createTarget`, `Target.attachToTarget`,
`Target.setAutoAttach`, `Target.closeTarget`, `Target.detachFromTarget`.

- `createBrowserContext` makes an incognito-like context with **independent cookies/storage**,
  optional `proxyServer`/`proxyBypassList` per context, and `originsWithUniversalNetworkAccess`
  for CORS grants. `disposeOnDetach` auto-cleans on session end.
  https://chromedevtools.github.io/devtools-protocol/tot/Target/
- **Cost model**: a BrowserContext is a *storage boundary*, not a process or window boundary —
  tabs from different contexts can share one Chrome window/process. This is the mechanism
  Playwright and Puppeteer both use for parallel test isolation, and community consensus is
  unambiguous that many contexts in one browser is dramatically cheaper than many browser
  processes ("Creating a Context is extremely fast... one browser with many contexts... is
  significantly more efficient than launching multiple browser processes").
  https://groups.google.com/a/chromium.org/g/devtools-dev/c/KhZaHlNMrJM ,
  https://qaskills.sh/blog/playwright-browser-contexts-isolation-guide
- **No documented hard numeric limit** on context count from Chromium itself — practical
  ceiling is host RAM/FD limits and each context's own tab/renderer-process footprint, not the
  context object itself. One dev-discussion thread advises capping "some reasonable number" but
  gives no figure — treat this as an open empirical question Glassbox should benchmark itself
  rather than trust a citation for.
- `disposeBrowserContext` force-closes all pages **without firing beforeunload** — a named
  session's cleanup should not assume graceful page teardown.
- **Gotcha**: `createTarget`'s `hidden` tab-creation flag only has a lifetime "limited to the
  session duration" (experimental) — don't rely on hidden targets outliving the attaching
  session.
- `setAutoAttach` auto-attaches to child targets (iframes-as-OOPIFs, workers) but the docs flag
  it may need to be **called recursively on newly auto-attached targets** to catch everything —
  a real trap for "capture everything under this tab" tooling.

## 2. Page, Runtime, Log/Console

- **Page**: `Page.navigate`, `Page.captureScreenshot` (`captureBeyondViewport` renders full
  document height ignoring window size), `loadEventFired`, `frameNavigated`,
  `javascriptDialogOpening`. `Page.getFrameTree` for iframe structure.
- **Runtime**: `Runtime.evaluate` (global-context eval), `Runtime.callFunctionOn`,
  `Runtime.getProperties`, `Runtime.awaitPromise`. Events: `consoleAPICalled`,
  `exceptionThrown`, `executionContextCreated/Destroyed/Cleared`.
  https://chromedevtools.github.io/devtools-protocol/tot/Runtime/
  - **Gotcha**: stack traces on exceptions only populate if `Runtime.enable` was already on
    when the error fired — enable order matters for a "capture everything" bundle.
  - **Gotcha (critical for Debugger interplay, see §8)**: `Runtime.evaluate` targets the live
    global context and does **not** safely resolve while the target is paused at a breakpoint;
    the V8-side entry point differs (`DebugEvaluate::Global` vs the paused-frame evaluator) —
    practitioners report it can hang. Use `Debugger.evaluateOnCallFrame` instead while paused.
- **Console domain is deprecated** — spec text literally says "use Runtime or Log instead."
  https://chromedevtools.github.io/devtools-protocol/tot/Console/
- **Log**: `Log.entryAdded` gives `source` (javascript/network/security/deprecation/etc),
  `level`, `text`, `url`, `lineNumber`, `stackTrace`, and (per type schema) a
  `networkRequestId` correlating to Network domain — this is the domain to catch
  browser-level violations/deprecations that never hit `console.*`.
  https://chromedevtools.github.io/devtools-protocol/tot/Log/

## 3. Network + Fetch — interception, HAR-quality capture, response bodies

- **Network.enable** takes `maxTotalBufferSize`/`maxResourceBufferSize`/`maxPostDataSize` to
  cap in-memory retained payloads, plus experimental `enableDurableMessages` to survive
  cross-process navigation.
- HAR-quality capture is **event assembly, not a native export** — CDP has no `Network.getHAR`.
  You subscribe to `requestWillBeSent` → `responseReceived` → `dataReceived` →
  `loadingFinished`/`loadingFailed` and build the HAR yourself; the reference implementation is
  Google's own `chrome-har` library (`harFromMessages`), and its own docs warn to handle the
  race where `responseReceived` can arrive **before** `requestWillBeSent` is processed.
  https://chromedevtools.github.io/devtools-protocol/tot/Network/
- `Network.getResponseBody` needs the request's `requestId`; bodies over the buffer limits
  above simply aren't retained. For **currently-intercepted** requests use
  `Network.getResponseBodyForInterception`, and for large/streaming payloads
  `Network.takeResponseBodyForInterceptionAsStream` returns a handle you page through via
  `IO.read` — this is mutually exclusive with the plain get-body call.
- **Fetch domain** (the interception layer): `Fetch.enable` (with `patterns` filter + optional
  `handleAuthRequests`), `Fetch.requestPaused` event, `Fetch.continueRequest` (can rewrite
  URL/method/postData/headers — **but overrides don't carry through redirect hops**, you must
  re-decide on each redirect), `Fetch.fulfillRequest` (full response mocking, base64 body),
  `Fetch.failRequest`, `Fetch.getResponseBody` (paused-response only).
  https://chromedevtools.github.io/devtools-protocol/tot/Fetch/
  - **Gotcha**: Fetch's `requestId` is a *different namespace* from Network's `requestId` for
    the same logical request — don't conflate them when joining interception state with
    HAR-style capture.
  - **Gotcha**: disabling Fetch mid-flight (before all paused requests are resolved) is
    documented as **undefined behavior** — a verification-bundle daemon must drain/resolve all
    pending `Fetch.requestPaused` before tearing down.

## 4. DOM + DOMSnapshot — full flattened tree + computed styles + layout

- **DOM domain**: `getDocument` (depth -1 for full subtree, `pierce` to cross iframe/shadow
  boundaries — **off by default**), `querySelector`/`querySelectorAll`, `getBoxModel` (content/
  padding/border/margin quads), `describeNode` (works **without enabling DOM domain** — good
  for lightweight probes), `resolveNode` (NodeId → `Runtime.RemoteObject`),
  `requestChildNodes` (async, delivered via `setChildNodes` event, not a return value).
  https://chromedevtools.github.io/devtools-protocol/tot/DOM/
  - **Gotcha**: `NodeId`s are invalidated on every `documentUpdated` event (effectively every
    navigation) — a session that caches node IDs across a `Page.navigate` will silently break;
    `BackendNodeId`s are more durable and don't require the domain to be enabled.
  - `getFlattenedDocument` is itself **deprecated in favor of `DOMSnapshot.captureSnapshot`**.
- **DOMSnapshot.captureSnapshot**: the actual answer to "full flattened snapshot with computed
  styles + layout." Returns (a) the full DOM tree flattened into an array (shadow DOM flattened
  in, iframes/template contents included), (b) a **layout tree** with paint-order option, and
  (c) computed styles filtered to a caller-supplied whitelist array (`computedStyles` param —
  you must ask for the specific CSS properties you want, it does not dump the whole computed
  style map by default). Optional flags for DOM listener details and including the UA shadow
  tree. https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/
  - This is the single most important method for Glassbox's "one-call layout+style bundle"
    hypothesis: one round-trip gets structure, geometry, and style together instead of N
    round-trips of `getBoxModel`/`getComputedStyleForNode` per node.

## 5. CSS — cascade/specificity introspection, "WHY is this element this color"

`CSS.getMatchedStylesForNode` return shape (requires `DOM.enable` first — "CSS objects can be
loaded using the get*ForNode() calls which accept a DOM node id"):
- `inlineStyle`, `attributesStyle` (e.g. `width=` HTML attr styling)
- `matchedCSSRules: RuleMatch[]` — CSS rules matching this node **from all applicable
  stylesheets, not filtered down to only the winning rule** — the browser's style engine does
  cascade resolution but the protocol hands you every candidate.
- `inherited` — the parent-to-root chain of inherited styles
- `pseudoElements` / `inheritedPseudoElements`
- `cssKeyframesRules`, `cssPositionTryRules`, `cssPropertyRules`, `cssAtRules`
https://chromedevtools.github.io/devtools-protocol/tot/CSS/

**The specificity gotcha (load-bearing for the "WHY is this color" hypothesis)**: I verified
this directly against the protocol type definitions. `RuleMatch` is just
`{ rule: CSSRule, matchingSelectors: integer[] }` — **no specificity field.** There is a
separate experimental `Specificity` type (`{a, b, c, components}` per CSS spec §selectors) but
it is **not attached to RuleMatch or CSSRule** — it lives on a different, narrower type used for
selector-level reporting (e.g. `:is()`/`:where()` argument specificity), not as a per-match
score you can sort matched rules by. **Chrome DevTools' own frontend computes cascade-winner
resolution in JavaScript from rule order + origin + `!important`, not by reading a specificity
number off the wire.** Practical implication: to answer "why is this element red," Glassbox
must combine `getMatchedStylesForNode` (ordered matched rules, engine-computed cascade order)
with `getComputedStyleForNode` (the final resolved value) and either (a) trust matched-rule
array order as a proxy for winning precedence, or (b) reimplement CSS specificity math
client-side like DevTools does — CDP does not do this arithmetic for you.
- `getComputedStyleForNode` returns the full resolved property list (name+value pairs), plus
  experimental Blink-internal "extra fields."
- `getPlatformFontsForNode` — actual rendered font family/PostScript name/glyph count per node,
  useful for "why does this look like the wrong font" debugging.
- `setStyleTexts` (batch style edits, ordered application) and `forcePseudoState` (pin
  `:hover`/`:focus`/etc for screenshotting interactive states) are the write-side tools for
  live cascade experimentation.

## 6. Accessibility — full AXTree dumps

`Accessibility.getFullAXTree` (optional `depth`, `frameId`), `getAXNodeAndAncestors` (node +
full ancestor chain to root, keyed by nodeId/backendNodeId/objectId — good for "why is this
specific element unreachable"), `getChildAXNodes`, `queryAXTree` (filter by `accessibleName`
and/or `role`, **includes accessibility-ignored nodes** in results).
https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/
- **Gotcha**: most methods explicitly require `Accessibility.enable()` first, and the domain
  itself documents a **performance cost while enabled** ("can impact performance until
  accessibility is disabled") — don't leave it on for the life of a long-running session if
  it's not needed for that particular verification call.
- No documented max tree size/depth — another open empirical question for large SPA pages.

## 7. Debugger — breakpoints, and what else works while paused

Core: `Debugger.enable`, `setBreakpoint`/`setBreakpointByUrl` (URL-pattern breakpoints survive
reload), `pause` ("stops on the next JavaScript statement"), `resume`
(`terminateOnResume` option), `paused` event (call frames, reason, hit breakpoint IDs, async
stack), `evaluateOnCallFrame`, `getScriptSource`, call-frame `scopeChain` (global/local/
closure/catch/block scope objects).
https://chromedevtools.github.io/devtools-protocol/tot/Debugger/

**What works while paused — this is architecture-inference, not a single CDP spec sentence, so
flag confidence accordingly:**
- Chromium is multi-process with one renderer process (and one JS main thread) per site
  (Site Isolation, default since Chrome 67). `Debugger.pause` freezes **that renderer's main
  thread only**; other tabs/targets in other renderer processes are architecturally untouched
  and remain fully controllable over their own CDP sessions.
  https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md
- Compositing runs on a **separate compositor thread** that "keeps working even when
  JavaScript is blocking everything else," redrawing the most recently committed layer tree
  independent of main-thread state. https://developer.chrome.com/docs/chromium/renderingng-architecture
  Reasoned conclusion (not directly spec-confirmed by a test I could cite): **`Page.
  captureScreenshot` on the paused target should still succeed**, since it can be served from
  the compositor's last-committed frame rather than requiring the main thread to run. I could
  not find a source that explicitly ran this experiment and reported the result — **treat this
  as a hypothesis to verify empirically in Glassbox's own test harness before depending on it**,
  not a confirmed fact.
- Confirmed, documented gotcha: **`Runtime.evaluate` is not the right tool while paused** — use
  `Debugger.evaluateOnCallFrame` with the paused call frame's ID; the two hit different V8
  internal evaluators and `Runtime.evaluate` in a paused context is reported to hang.
- Other sessions attached to *other* targets are unaffected by one target being paused — this
  follows directly from the one-thread-per-renderer-process model above.
- Multiple CDP clients on one target: supported since Chrome 63 ("DevTools now supports
  multiple remote debugging clients by default"); the `chrome.debugger` **extension API**
  layers an additional single-owner restriction ("another debugger is already attached") on
  top of that raw capability, so the "another debugger already attached" error is specific to
  the `chrome://` extension surface, not raw CDP-over-websocket clients.
  https://developer.chrome.com/docs/extensions/reference/api/debugger

## 8. Profiler + CSS coverage

- `Profiler.startPreciseCoverage({callCount, detailed})` — JS coverage; **coverage for code
  executed before the enable call is documented as incomplete**, so a verification bundle must
  enable coverage before navigation/interaction, not after.
- `CSS.startRuleUsageTracking` / `CSS.stopRuleUsageTracking` — CSS rule usage (used vs. dead
  CSS) — pairs naturally with JS coverage for a "what shipped but never ran" report.
- Both are the mechanism behind Chrome DevTools' Coverage panel and Lighthouse's unused-code
  audits.

## 9. Tracing

`Tracing.start` (categories, `transferMode`: `ReportEvents` vs `ReturnAsStream`,
`streamFormat`: json/proto), `Tracing.end`, `Tracing.getCategories`,
events `dataCollected` (ReportEvents mode) and `tracingComplete` (reports if the ring buffer
wrapped and data was lost). Default buffer 200MB, override via `traceBufferSizeInKb`.
**Gotcha**: JSON trace format is flagged "will be deprecated soon" in favor of proto — new
integrations should default to proto + stream mode. Screenshot capture embedded in traces is
separately budget-capped (**500px max size, 450 max screenshots per session**) — don't expect
full-resolution frame-by-frame video out of a trace.
https://chromedevtools.github.io/devtools-protocol/tot/Tracing/

## 10. Overlay, Emulation, Input

- **Overlay**: `highlightNode` (by nodeId/backendNodeId/objectId/selector, configurable
  content/padding/border/margin colors), `highlightRect` — **explicitly documented as NOT
  handling device pixel ratio correctly**, caller must pre-scale coordinates for DPR≠1 —
  `setShowPaintRects`, `setShowLayoutShiftRegions` (CLS visualization), `setShowFPSCounter`,
  `getHighlightObjectForTest`. Several deprecated siblings exist (`highlightFrame`,
  `setShowHitTestBorders`, `setShowWebVitals`) — don't build on those.
  https://chromedevtools.github.io/devtools-protocol/tot/Overlay/
- **Emulation**: `setDeviceMetricsOverride` (viewport, DSF, mobile flag, orientation),
  `setEmulatedMedia` (drives `prefers-color-scheme`/`prefers-reduced-motion` etc via CSS
  media-feature overrides — this is how Glassbox tests dark mode without a real OS toggle),
  `setEmulatedVisionDeficiency` (achromatopsia/deuteranopia/protanopia/tritanopia — explicitly
  "best-effort," not medically precise), `setTimezoneOverride` (ICU locale string; affects JS
  `Date` but not necessarily every system-level op), `setGeolocationOverride`,
  `setCPUThrottlingRate` (multiplier, 1=none). Network throttling itself lives on
  `Network.emulateNetworkConditions`, a sibling method on the Network domain rather than
  Emulation. Device-metrics override changes only the **page viewport**, not real browser UI
  chrome. https://chromedevtools.github.io/devtools-protocol/tot/Emulation/
- **Input**: `dispatchMouseEvent`, `dispatchKeyEvent` (virtual key codes + modifiers + editing
  commands), `dispatchTouchEvent`, `insertText` (experimental — for IME/emoji-picker-style
  insertion that doesn't come from a keypress). The official protocol reference does **not**
  document whether these traverse the full compositor hit-testing pipeline into iframes/shadow
  DOM — this is inherited general Chromium knowledge (Input domain events are injected at the
  same layer as real OS input and do hit-test through the render surface, which is why
  Puppeteer/Playwright rely on it for cross-iframe clicks) rather than something the spec page
  itself asserts; **verify empirically for nested OOPIF + closed shadow root cases** rather than
  assuming from the doc.

## 11. Page.startScreencast — ride-along viewing feasibility

`Page.startScreencast({format: 'jpeg'|'png', quality: 0-100, maxWidth, maxHeight,
everyNthFrame})` streams `Page.screencastFrame` events (base64 image + metadata); **each frame
must be acknowledged via `Page.screencastFrameAck` before the next one is sent** — this is a
back-pressure mechanism, not fire-and-hose. `everyNthFrame:2` halves an effective 30fps source
to ~15fps.

Real-world evidence this is production-viable but has sharp edges: agent-browser (vercel-labs)
ships a screencast-based live-view stream server today, and its own open issue #632 shows the
concrete failure mode — hardcoded `maxWidth:1280, maxHeight:720` causes CDP to **downscale**
frames for high-DPR mobile viewports (e.g. iPhone 15 at 393×852 CSS px, 3x DPR) to ~333×720
actual pixels while frame metadata still reports the original dimensions, producing blurry
output; the fix requested is making max dimensions configurable per stream.
https://github.com/vercel-labs/agent-browser/issues/632
**Design implication for Glassbox**: don't hardcode screencast dimensions; derive
`maxWidth`/`maxHeight` from the emulated device's physical (CSS×DPR) pixels, not CSS pixels.

## 12. headless=new vs headed in 2026

Chrome's headless architecture underwent a real consolidation, finished by Chrome 132: the old
lightweight headless implementation was **removed from the main Chrome binary**; the unified
"new" headless mode (introduced Chrome 112) runs the actual full Chrome rendering code path
under the hood, so headless-vs-headed rendering gaps (fonts, GPU/canvas handling) are "nearly
gone." If you specifically want the old lean/fast headless-only binary for high-volume batch
work, it now ships as a **separate download**, `chrome-headless-shell`, decoupled from the main
browser. Tradeoff reported: new headless is closer to real-user rendering but is "substantially
more detectable as a browser fingerprint" than the old shell — irrelevant to Glassbox's
local-dev-tool use case (nothing to evade), but relevant if Glassbox's headless mode is ever
reused for scraping-adjacent work. **A separate, unresolved 2026 wrinkle**: "Chromium 147+
removed the `HeadlessExperimental.beginFrame` CDP command," breaking frame-synchronous
screenshot pipelines that depended on it in sandboxed/system-Chromium environments — worth
guarding against if Glassbox ever wants deterministic frame-perfect capture instead of
wall-clock-timed `Page.captureScreenshot`.
https://www.browserstack.com/guide/playwright-headless-chrome ,
https://chromedevtools.github.io/devtools-protocol/tot/HeadlessExperimental/

## 13. WebDriver BiDi vs CDP status, 2026

BiDi is the W3C-standardized cross-browser successor path, and its Firefox story is basically
finished: Mozilla deprecated CDP support starting Firefox 129 (128 ESR was the last
CDP-capable transition release), and Selenium fully removed Firefox CDP support as of Selenium
4.29.0. https://fxdx.dev/deprecating-cdp-support-in-firefox-embracing-the-future-with-webdriver-bidi/
For **Chrome specifically**, the picture is the opposite: "Chromium-based browsers will
continue to use CDP for debugging purposes" indefinitely, since Google controls both the
browser and the protocol, and multiple 2026 sources converge on the same verdict — "CDP's
granular access to network interception, JavaScript profiling, DOM snapshots, and
accessibility trees has no equivalent in BiDi today," making CDP "the richer choice for Chrome"
for production AI-agent tooling. https://zylos.ai/research/2026-04-05-browser-automation-ai-agents-2026-landscape/
**Conclusion for Glassbox**: since Glassbox is explicitly Chrome/Chromium-only and wants
deep white-box access (breakpoints, coverage, cascade introspection, AXTree, precise
interception) that BiDi doesn't offer, CDP is the correct and low-risk choice — this isn't a
protocol Glassbox needs a migration plan away from.

## 14. Multi-client CDP: daemon + DevTools frontend simultaneously

Confirmed as a supported, common pattern: "a web page entity can be debugged by Chrome DevTools
(Client1) and simultaneously connected by puppeteer (Client2) for automated control" — multiple
remote-debugging clients on one target have been supported by default since Chrome 63.
Mechanically: connect over `--remote-debugging-port`, discover targets via the HTTP JSON
endpoint, then `Target.attachToTarget({targetId, flatten: true})` per client to get your own
`sessionId`; flatten mode multiplexes many sessions over one websocket by tagging each command
with its `sessionId`, and different sessions **may reuse the same numeric command `id`** without
collision since ids are scoped per-session. Non-flatten mode is explicitly slated for eventual
removal — build only on flatten mode. Session hierarchy: sessions attached from within a parent
session are children of it, and **closing a parent session via `Target.detachFromTarget` closes
all its child sessions** — a real gotcha if a daemon nests a debugging session inside a
higher-level browser session and doesn't expect a cascade teardown.
https://github.com/aslushnikov/getting-started-with-cdp ,
https://chromedevtools.github.io/devtools-protocol/tot/Target/
**Caveat**: this multi-client freedom is a raw-CDP/websocket property. The `chrome.debugger`
**extension** API imposes its own single-attachment lock ("another debugger is already
attached to the tab") — irrelevant to Glassbox since it isn't a Chrome extension, but a trap
for anyone reading extension-API discussions and assuming they generalize to raw CDP.

## Design implications summary (see structured output for the compressed list)

Glassbox's daemon should: default to one Chrome process + N `Target.createBrowserContext`
named sessions rather than N processes (cheap, ~5ms, real isolation) — this is *the* validated
architectural bet, since both leading incumbents are missing it; treat `DOMSnapshot.
captureSnapshot` as the one-call structure+layout+style primitive rather than composing
per-node DOM/CSS calls; do not trust CDP to hand back a specificity score — reimplement cascade
resolution client-side like DevTools itself does, or lean on matched-rule order +
`getComputedStyleForNode`; verify (don't assume) that screenshotting a paused target succeeds,
since the architectural argument is strong but unconfirmed empirically in any source found;
size screencast `maxWidth`/`maxHeight` from device DPR, learning from agent-browser's own bug;
use flatten-mode `Target.attachToTarget` throughout since non-flatten is being retired; and
treat WebDriver BiDi as a non-issue for a Chrome-only tool wanting this level of introspection.

---

## Sources

- https://chromedevtools.github.io/devtools-protocol/tot/Target/
- https://chromedevtools.github.io/devtools-protocol/tot/Fetch/
- https://chromedevtools.github.io/devtools-protocol/tot/Network/
- https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/
- https://chromedevtools.github.io/devtools-protocol/tot/Debugger/
- https://chromedevtools.github.io/devtools-protocol/tot/Runtime/
- https://chromedevtools.github.io/devtools-protocol/tot/Log/
- https://chromedevtools.github.io/devtools-protocol/tot/Console/
- https://chromedevtools.github.io/devtools-protocol/tot/DOM/
- https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/
- https://chromedevtools.github.io/devtools-protocol/tot/CSS/
- https://chromedevtools.github.io/devtools-protocol/tot/Overlay/
- https://chromedevtools.github.io/devtools-protocol/tot/Emulation/
- https://chromedevtools.github.io/devtools-protocol/tot/Input/
- https://chromedevtools.github.io/devtools-protocol/tot/Tracing/
- https://chromedevtools.github.io/devtools-protocol/tot/HeadlessExperimental/
- https://github.com/ChromeDevTools/chrome-devtools-mcp
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/926
- https://github.com/vercel-labs/agent-browser
- https://github.com/vercel-labs/agent-browser/issues/1068
- https://github.com/vercel-labs/agent-browser/issues/632
- https://github.com/aslushnikov/getting-started-with-cdp
- https://groups.google.com/a/chromium.org/g/devtools-dev/c/KhZaHlNMrJM
- https://qaskills.sh/blog/playwright-browser-contexts-isolation-guide
- https://developer.chrome.com/docs/extensions/reference/api/debugger
- https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md
- https://developer.chrome.com/docs/chromium/renderingng-architecture
- https://www.browserstack.com/guide/playwright-headless-chrome
- https://fxdx.dev/deprecating-cdp-support-in-firefox-embracing-the-future-with-webdriver-bidi/
- https://zylos.ai/research/2026-04-05-browser-automation-ai-agents-2026-landscape/
- https://developer.chrome.com/blog/webdriver-bidi
