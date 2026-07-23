# Failure-Mode Taxonomy: Why Existing Agent-Browser Tools Need Babysitting

**Purpose:** This is a requirements-validation document for Glassbox. Every claim below is
sourced to a GitHub issue, README, vendor doc, or practitioner post from the current
generation of agent-browser tooling (playwright-mcp, chrome-devtools-mcp, browser-use,
Puppeteer, Stagehand, Anthropic computer-use, and emerging "daemon" challengers like Vercel's
agent-browser and agent-browser-protocol). The goal: a root-cause taxonomy of *why* an agent
using today's tools needs a human to babysit it, and for each root cause, the specific
architectural choice that removes the need for babysitting.

The short version, up front: almost every failure class below traces to one design gap —
**none of the incumbent tools separate "the action was dispatched" from "the world actually
changed the way the agent thinks it did."** Playwright-MCP and Puppeteer optimize for
*driving* the browser; Chrome DevTools MCP optimizes for *observing* it after the fact;
nothing treats "verify, then report" as the atomic unit of a tool call. That gap is exactly
what a verification-bundle architecture (console + network + a11y + layout + screenshot,
correlated to one action, on disk) is designed to close.

## 1. Timing / Races

**What it is:** the agent acts before the page (or dev server) has reached the state it
assumes — a click lands before a re-render finishes, a read happens before an XHR resolves,
an edit collides with a hot-module-reload cycle.

**Evidence:**
- browser-use #3972: an agent repeatedly evaluated an insurance-calculator SPA immediately
  after navigation, found no interactive elements, and looped through re-navigation instead of
  waiting — *despite the task explicitly specifying mandatory wait windows (5s initial, 3s
  after scroll)*. Its own reasoning log records "the page loaded but does not display the
  expected interactive elements," i.e. it observed the race and still didn't correct for it.
  (https://github.com/browser-use/browser-use/issues/3972)
- Playwright's actionability-check docs exist *because* naive `.click()` without waiting is
  unreliable: it auto-waits for attached, visible, enabled, and "stable (not animating)" —
  tacit admission that a bare CDP click into a transitioning DOM fails often enough to need a
  whole subsystem. (https://github.com/microsoft/playwright/issues/14946)
- Vite/agent-driven-dev-loop write-ups describe a concrete HMR race: "there's typically a
  brief window — a few seconds — when HMR feels broken" right after an agent edits a file under
  active hot-reload — the window in which an agent verifying its own edit screenshots a
  half-swapped module tree. chrome-devtools-mcp's own `wait_for` tool compounds this by
  silently capping the caller-supplied timeout at 30,000ms regardless of what's requested — even
  *explicit* waits aren't honored. (https://antigravitylab.net/en/articles/app-dev/antigravity-hmr-hot-reload-not-working-fix, https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/624)

**Root cause / fix:** every incumbent tool treats "dispatch the input event" and "the page is
legible" as the same instant; auto-wait heuristics approximate this only for the element being
acted on, not the surrounding page. A daemon that defines an explicit "settled" boundary and
freezes JS/virtual time between steps eliminates the race by construction. `agent-browser-protocol`
already does this: it "injects real input through Chromium's input system, waits for an
engine-defined 'settled' boundary, captures compositor output... JavaScript and virtual time
freeze between steps," so "agents never race against the browser." (https://github.com/theredsix/agent-browser-protocol)
For Glassbox: capture the verification bundle *after* a settle signal (network-idle + paint-idle
+ no pending mutation-observer callbacks), never on a fixed sleep.

## 2. Stale References (snapshot refs invalidated by re-render)

**What it is:** an agent gets an accessibility-tree snapshot with element refs (`e1`, `e2`…),
the DOM re-renders for any reason, and the next tool call uses a ref that no longer resolves.

**Evidence:**
- Playwright MCP's own docs state the constraint: refs are "stable within a single snapshot —
  the same element always has the same ref until the page changes," and after any navigation,
  click, or DOM-changing action the client must re-snapshot or risk "element not found" errors.
  (https://playwright.dev/mcp/snapshots)
- #514, "Element missing from accessibility snapshot": an element that visibly exists on the
  page simply doesn't appear in the ref table, so there's no ref to act on *before* staleness
  even enters the picture. (https://github.com/microsoft/playwright-mcp/issues/514)
- #1177 extends this to modern frameworks: elements rendered into overlay/portal containers by
  Ant Design, Angular CDK, etc. aren't captured in the snapshot at all, "effectively blocking
  automation for highly common web UI patterns." #910's persistent `ReferenceError: element is
  not defined` from `browser_evaluate` is a second-order symptom of the same gap — code written
  against a prior snapshot's handle breaks once the handle no longer resolves. (https://github.com/microsoft/playwright-mcp/issues/1177, https://github.com/microsoft/playwright-mcp/issues/910)

**Root cause / fix:** snapshots are a point-in-time projection with no subscription/invalidation
model — the agent learns a ref died only when the next action against it 404s. Re-snapshot-
on-mutation (a MutationObserver-backed daemon that invalidates and reissues refs automatically,
or at minimum flags "this snapshot is stale") turns a silent trap into a structured error. Only
a daemon that owns the page continuously — not a stateless snapshot call — has a persistent-enough
view of the DOM to know when a ref died.

## 3. Modal Interrupts (dialogs, popups, cookie banners, focus stealing)

**What it is:** a native dialog, portal-rendered modal, or cookie-consent banner appears
mid-action and either blocks the automation call indefinitely or silently eats the input the
agent thought was going to the page.

**Evidence:**
- Playwright MCP #595, "dialog blocks snapshot": when `browser_click` triggers a native
  `alert`/`confirm`/`prompt`, "the call currently hangs until the dialog is handled. There is
  no way for the client to know that a dialog appeared." Maintainers tagged it `backlog` /
  `open to a pr` — acknowledged, unfixed. (https://github.com/microsoft/playwright-mcp/issues/595)
- The same #1177 overlay/portal gap doubles as a modal-interrupt problem: a dropdown or modal
  rendered into a portal is both unreadable *and* frequently sitting on top of the element the
  agent is trying to click, so the click silently no-ops or hits the wrong target.
- Cookie-consent banners are common enough that a cottage industry of workarounds
  (`playwright-autoconsent`, pre-seeded cookies, request-blocking the consent script) exists
  outside the core tools, because the automation has no native "detect and dismiss
  interstitial" primitive — practitioner synthesis names "clicks fail when another element
  covers the target's click point, such as a consent banner or modal" as a concrete
  silent-failure scenario agents hit in production. (https://www.browserstack.com/guide/playwright-cookies, https://dev.to/eggp/why-your-ai-agent-says-done-but-nothing-actually-happened-1no3)

**Root cause / fix:** dialogs and interstitials are architecturally just more browser state, but
the tools treat them as an unmodeled exception path (native dialogs literally block the CDP
command queue) instead of a first-class observation. A verification bundle that always reports
"is anything covering/blocking the viewport or holding native dialog focus" as a structured
field — not just a hang or a swallowed click — converts an invisible failure into a legible one;
configurable accept/dismiss-by-default dialog policy closes the rest.

## 4. Session Death (browser crash, daemon restart, context loss)

**What it is:** the browser process crashes, disconnects, or the JS execution context is torn
down mid-navigation, and the automation layer either throws unhandled or silently proceeds
against a dead handle.

**Evidence:**
- Puppeteer #13056: `"Error: Execution context was destroyed"` thrown inside an isolated world
  "is not caught" — an unhandled exception that can crash the host Node process. This exact
  message recurs across at least five separate Puppeteer issues spanning 2017–2024 (#3323,
  #4154, #4869, #5056, #13056) — a *chronic, never-fully-fixed* bug class for the project's
  entire life. (https://github.com/puppeteer/puppeteer/issues/13056, https://github.com/puppeteer/puppeteer/issues/4869)
- Puppeteer #10491 / #11632: "Navigation failed because browser has disconnected" — the
  recommended mitigation is literally "listen for the 'disconnected' event... and reconnect
  using the stored browserWSEndpoint," i.e. reconnection logic the *caller* has to build because
  the library doesn't own session continuity. (https://github.com/puppeteer/puppeteer/issues/10491)
- chrome-devtools-mcp #1152: intermittent `tools/call` timeouts / "transport closed" even while
  the underlying CDP websocket is reachable — a session-lifecycle bug during long-lived agent
  runs. Its troubleshooting doc separately catalogs "Target closed" (browser crashed on launch)
  and a macOS crash where "Chrome launched by an MCP client crashes when a Web Bluetooth prompt
  appears" as *documented, expected* failure modes the user works around by hand. (https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1152, https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md)
- The driving-vs-debugging comparison notes Chrome DevTools MCP "attaches to a real Chrome
  window by default — fine for ad-hoc debugging, terrible for overnight agent runs because the OS
  will eventually decide to swap, lock, or sleep": session death isn't always a bug, sometimes
  it's the OS reclaiming a window the tool never asked to keep alive. (https://stevekinney.com/writing/driving-vs-debugging-the-browser)

**Root cause / fix:** none of these tools own the browser lifecycle as a durable, supervised
resource — the browser is a child process a call happens to be talking to over CDP, and when it
dies the *client* (often the agent itself, mid-reasoning) has to notice, with no consistent typed
error. A daemon that owns Chromium as a supervised long-lived process can detect crash/disconnect,
restart, and reattach sessions transparently, reporting "session died, resuming" instead of an
ambiguous transport error — the strongest single argument here for daemon-owned Chromium.

## 5. Token Bloat (huge snapshots flooding context)

**What it is:** full accessibility-tree snapshots, screenshots, and console/network logs are
large enough that a handful of verification steps exhaust an agent's context budget.

**Evidence:**
- #889: a version bump from 0.0.30 to 0.0.32 caused a **6x** increase in tokens used to solve
  the identical task; the issue asks for low/medium/high verbosity controls.
  (https://github.com/microsoft/playwright-mcp/issues/889)
- #915, "Optimize browser_snapshot": the tool returns the *entire* page including
  hidden/non-interactable elements; "LLM token limit is reached just within 5–10 steps of
  automation." (https://github.com/microsoft/playwright-mcp/issues/915)
- Practitioner benchmark: "Playwright MCP Burns 114K Tokens Per Test. The New CLI Uses 27K" —
  a ~4.2x reduction from swapping heavy MCP JSON snapshots for compact text.
  (https://scrolltest.medium.com/playwright-mcp-burns-114k-tokens-per-test-the-new-cli-uses-27k-heres-when-to-use-each-65dabeaac7a0)
- Playwright MCP ships 26–29 tools by default; a "slim mode" cuts this to 3 — "a tacit
  admission that 29 tools is too many to load by default," citing research that "LLMs start to
  struggle at around 30 tools for large models and just 19 tools for smaller models." Teams
  given the full set saw Claude take redundant screenshots after every trivial action — a
  second, compounding source of waste on top of snapshot size; a separate Claude Code
  practitioner report found "context consumption dropped 93% compared to Chrome DevTools MCP"
  after switching to a CLI emitting compact text instead of heavy MCP JSON. (https://www.speakeasy.com/blog/playwright-tool-proliferation)

**Root cause / fix:** snapshot payloads are unfiltered projections of the entire DOM/a11y tree
rather than a diff or relevance-ranked view, and tool surfaces expose every CDP capability as a
first-class tool instead of composing primitives behind fewer, richer calls. This is the direct
rationale for a one-call **verification bundle**: instead of choosing among 26 overlapping
tools and re-fetching a full snapshot after every micro-action, a single call returns exactly
the console+network+a11y+layout+screenshot diff relevant to the action just taken, pre-filtered
to changed elements, written to disk with only a compact pointer returned into context. Disk
artifacts + "reference by path, not inline blob" is the mechanism that decouples verification
thoroughness from context cost.

## 6. Perception Gaps (agent can't see WHY something is wrong)

**What it is:** the agent can observe *that* something is wrong (a screenshot looks off, a
click did nothing) but has no access to the causal chain — which CSS rule, which failed
request, which console error — that explains *why*.

**Evidence:**
- Anthropic's own computer-use docs name this as a first-class, documented limitation:
  "**Computer vision accuracy and reliability:** Claude might make mistakes or hallucinate when
  outputting specific coordinates," and "**Tool selection accuracy and reliability:** Claude
  might make mistakes or hallucinate when selecting tools... reliability might be lower when
  interacting with niche applications." The same doc's closing guidance concedes perception
  alone isn't trustworthy: "Always carefully review and verify Claude's computer use actions
  and logs. Do not use Claude for tasks requiring perfect precision... without human
  oversight." (https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- Practitioner taxonomy of "silent" failures lists causes an agent literally cannot see from a
  screenshot or DOM snapshot alone: "rate-limited API calls proceeding undetected," "network
  request rejections going unobserved," "JavaScript execution failures in the UI layer" — all
  invisible unless the agent is also watching network and console alongside the visual state.
  (https://dev.to/eggp/why-your-ai-agent-says-done-but-nothing-actually-happened-1no3)
- Cascade/CSS-specificity bugs are the canonical example: a screenshot shows a button in the
  wrong color, but nothing in a screenshot or plain a11y snapshot tells the agent *which rule*
  (specificity, source order, `!important`, a stale cached stylesheet) is winning — that
  requires computed-style/cascade introspection incumbent tools don't expose at all.

**Root cause / fix:** screenshot-driven ("computer use") and accessibility-tree-driven
(Playwright-MCP-style) perception both stop at "what is rendered," never "what caused what is
rendered" — neither pixel coordinates nor an a11y label encodes causality. This is the
requirements case for **deep white-box debugging** as first-class, not a nice-to-have:
computed-style/cascade introspection ("which rule, from which source, won this property"),
breakpoints, and coverage data give the agent the causal layer both screenshots and a11y
snapshots omit by construction. Anthropic's own limitations list is effectively a direct
requirement: don't rely on the model to infer causality from pixels — give it structured
causal data instead.

## 7. Single-Session Contention (parallel agents fighting over one browser)

**What it is:** two or more agent processes (or two tool calls from the same orchestration
run in parallel) try to drive the same browser/profile, and one locks the other out or both
silently corrupt each other's state.

**Evidence:**
- #893, "multiple parallel claude-code agents ... results in interference": agents "often
  come back with very different results if launched in parallel vs sequentially," diagnosed
  directly: "I can see them all fighting over the same tab in the same browser window" —
  because "all agents share a single MCP server instance and compete for control of the same
  browser tab." Giving each agent its own tab reduced but didn't eliminate the inconsistency.
  (https://github.com/microsoft/playwright-mcp/issues/893)
- #769: `"Error: Browser is already in use for ...mcp-chrome-profile, use --isolated to run
  multiple instances"` — a hard lock at the Chrome user-data-dir level, since "a persistent
  profile can only be used by one browser instance at a time." (https://github.com/microsoft/playwright-mcp/issues/769)
- #1294 (open feature request) asks for first-class isolated instances with separate
  `userDataDir`s, because "the fixed profile design assumes single-instance usage" and there's
  no way for an MCP *client* to request isolation — the caller manages temp profiles by hand.
  browser-use #1920 shows the same gap elsewhere: "I want multiple agents to operate the same
  browser consecutively, but an error occurs with the second agent" — a second agent opening
  tabs on a browser already claimed by a first causes the browser to shut down entirely, not
  just the second agent's action to fail. (https://github.com/microsoft/playwright-mcp/issues/1294, https://github.com/browser-use/browser-use/issues/1920)

**Root cause / fix:** the de facto session model is "one browser profile, one client, implicit
ownership" — there's no named-session abstraction the server enforces; isolation, where it
exists, is a flag the caller must remember to pass at the OS-profile-lock level rather than a
designed multi-tenant scheduler. This is the direct case for **daemon-owned, named parallel
isolated sessions** as a load-bearing primitive, not an opt-in flag: identity and isolation
should be the default shape of every connection, each named session getting its own browser
context by construction, so "two agents, two sessions" is structurally impossible to collide.

## 8. Silent Failure (action "succeeded" but nothing happened)

**What it is:** a tool call returns success/no-error, the agent marks the step done and moves
on, and the intended world-state change never actually occurred.

**Evidence:**
- The clearest practitioner framing: "When AI agents declare a task complete, nothing may have
  actually changed — the button's still there unclicked, the form's still empty and unsubmitted,
  and the page hasn't moved." The root-cause claim is architectural, not model-capability:
  **"Executing an action ≠ Achieving a state,"** yet current designs treat the two as identical
  because the agent alone decides when it's done, with no independent verification step.
  Separating "propose intent" from "verify resulting state" as two distinct phases dropped
  "invalid actions... from 80%+ to 0%" in the author's own system — attributed explicitly to
  architecture, not a bigger model. (https://dev.to/eggp/why-your-ai-agent-says-done-but-nothing-actually-happened-1no3)
- browser-use #1157: the agent gets stuck "continuously cycling through Step 1" forever after
  opening a page — initialization, screenshots, and element detection all report success at
  every layer, yet the agent's own completion logic never fires: success signals at the tool
  level provided zero information about task-level progress. (https://github.com/browser-use/browser-use/issues/1157)
- The same synthesis piece names concrete scenarios: "the page loads but displays stale data,
  the API returns cached results, or the session timed out but the page still renders," and "a
  form that validates asynchronously might fail to register that a field was filled
  incorrectly, and the agent submits the form while it silently fails, then moves on thinking
  the step succeeded." A dispatched-click-with-no-effect is functionally identical, from the
  caller's point of view, to the modal-interrupt case in §3 — the tool layer has no notion of
  "verify the click had an observable effect," it only knows the CDP command did not error.

**Root cause / fix:** "the CDP call didn't throw" and "the intended state change happened" are
conflated at every layer — driver, MCP wrapper, and often the agent's own completion logic all
treat absence-of-error as success. One-call verification bundles close this gap only if
verification is *mandatory and automatic*: every action-tool call should return evidence (did
the DOM mutate? did a request fire and resolve? did a new console error appear?) in the same
response, not a bare ack an under-specified agent can skip past.

## 9. Environment Drift (wrong viewport/theme vs what the user actually sees)

**What it is:** what the agent screenshots and verifies against doesn't match what a human
would see in their own browser — different viewport, color scheme, font rendering, DPR.

**Evidence:**
- Headless vs. headed Chrome render fonts differently at the pixel level: "when using a
  screenshot in headless chrome the anti-aliasing... of text is grey-scale, whereas in visible
  chrome it's colour," traced to `--font-render-hinting` defaulting to `full` in headless mode.
  A Chromium-level, not tool-level, discrepancy — filed as Chromium bug 744577 and Puppeteer
  #2410, both long-standing. (https://bugs.chromium.org/p/chromium/issues/detail?id=744577, https://github.com/puppeteer/puppeteer/issues/2410)
- "The Dark Mode Screenshot Debacle" describes CI screenshots returning a different theme than
  local baselines because "the CI emulator runs with system-wide dark mode enabled by default
  while baseline screenshots were captured in light mode" — identical layout, different theme,
  read as a regression, or worse, a false-clean diff. (https://medium.com/@begunova/issue-4-the-dark-mode-screenshot-debacle-5221c7bec8b8)
- Best-practice guidance exists only because this drift is common: "capture pages in light and
  dark mode on desktop and one mobile viewport... if the page has a distinct mobile dark mode,
  test that viewport directly instead of resizing a desktop result," implying emulated
  screenshots are not a substitute for testing the operator's real target viewport.
  (https://www.drizz.dev/post/layout-testing-for-mobile-apps)

**Root cause / fix:** automation defaults (headless, default viewport, unset color-scheme) are
chosen for CI throughput, not fidelity to what a specific human sees. No incumbent tool asks
"what does the user's environment look like" and matches it by default. A daemon-owned session
that can introspect the operator's actual viewport/theme/DPR and default captures to that — plus
a human ride-along mode viewing the *same* session the agent drives — collapses this gap by
construction instead of relying on both sides to match settings by hand.

## Cross-Cutting Pattern

Three structural gaps recur across almost every issue cited:

1. **No durable session owner.** Puppeteer/Playwright-MCP/browser-use treat the browser as a
   resource a single call happens to be talking to, not a supervised long-lived process —
   explains §4 (session death), most of §7 (contention), and half of §2 (nobody watches for ref
   invalidation because nobody owns the DOM continuously).
2. **No mandatory verification step.** "Tool call returned without error" and "the world
   changed as intended" are conflated everywhere — explains §1, §3, §6, §8 directly, and is the
   single biggest lever: the eggp article's own data (invalid actions 80%+ → 0%) suggests this
   matters more than perceptual or performance improvements.
3. **No context-aware output shaping.** Full, unfiltered a11y trees and screenshots are
   returned by default; filtering/diffing exists only as bolt-on flags (`--isolated`, slim
   mode, verbosity levels) rather than defaults — explains §5, and a contributor to §6.

Every Glassbox core hypothesis maps onto closing one of these gaps: daemon-owned Chromium +
named isolated sessions → gap 1; one-call verification bundles → gap 2; disk artifacts + deep
white-box introspection → gap 3.

## Table: Failure Mode → Fix → Feature That Pays Rent

| Failure mode | Root cause | Architectural fix | Glassbox feature |
|---|---|---|---|
| Timing/races | dispatch ≠ settled | engine-defined "settled" boundary, freeze between steps | daemon session w/ settle detection |
| Stale refs | point-in-time snapshot, no invalidation | mutation-aware re-snapshot / stale-ref errors | daemon holding persistent DOM view |
| Modal interrupts | dialogs unmodeled exception path | structured "blocked by X" field, dialog policy | verification bundle |
| Session death | browser is unsupervised child process | supervised daemon w/ crash-detect+resume | daemon owning Chromium via CDP |
| Token bloat | unfiltered full-tree payloads, tool proliferation | diff/relevance-filtered output, disk + pointer | verification bundle + disk artifacts |
| Perception gaps | pixels/labels encode no causality | cascade/computed-style introspection, breakpoints | deep white-box debugging |
| Session contention | implicit single-profile ownership | mandatory named isolated sessions | named parallel isolated sessions |
| Silent failure | "no error" conflated with "state changed" | mandatory action→effect verification | verification bundle (default, not opt-in) |
| Environment drift | CI-default viewport/theme, not user's | match operator's real environment; shared view | human ride-along + daemon session config |

## Surprises (vs. first-principles hypotheses)

- The most citation-dense, best-evidenced failure mode was **not** a low-level CDP problem but
  a *process/architecture* one: agents not verifying their own success (§8). The eggp piece's
  80%→0% invalid-action number is the strongest quantified result found in this search, and
  argues a mandatory verification step alone may matter more than any perceptual improvement.
- Token bloat compounds with **tool-count-induced bad behavior** (agents given 26+ tools take
  redundant screenshots even when the outcome is already known) — an argument for a narrow,
  opinionated tool surface over a maximalist one.
- At least one incumbent (`agent-browser-protocol`) is already converging independently on the
  exact "freeze virtual time between steps" idea Glassbox needs for race-free verification —
  validates the approach, but means Glassbox should study their CDP mechanism, not re-derive it.
- Anthropic's own documentation is unusually candid that computer-use coordinate/tool selection
  is *expected* to hallucinate — a vendor admitting, in a shipped-product doc, exactly the
  perception gap Glassbox is designed around.

## Design Implications

- Make verification the *default return value* of every action tool, not a separate tool the
  agent must remember to call — silent failure is the highest-leverage fix in this taxonomy.
- Session isolation must be the default topology, not an opt-in flag — every contention issue
  found traces to isolation being something the caller has to remember to request.
- Treat "settled" as a real, engine-level signal (network-idle + paint-idle + no pending
  mutation callbacks), not a fixed sleep — a solved problem (`agent-browser-protocol`) worth
  studying directly rather than re-deriving.
- Budget context deliberately: return small, causally-rich summaries and write full payloads
  (a11y tree, console/network log, screenshots) to disk with a path reference — every
  token-bloat issue found stemmed from returning the full payload inline by default.
- White-box introspection (cascade/computed-style, coverage, breakpoints) is the direct fix for
  a limitation Anthropic documents as inherent to screenshot/coordinate perception, and default
  captures should match the operator's real environment (viewport, theme, DPR) with a
  ride-along view so human and agent provably see the same rendered state.

## Sources

- Playwright MCP snapshot ref semantics — https://playwright.dev/mcp/snapshots
- Playwright MCP #514, element missing from accessibility snapshot — https://github.com/microsoft/playwright-mcp/issues/514
- Playwright MCP #910, `browser_evaluate` ReferenceError on stale element / #1177, overlay-portal elements not captured — https://github.com/microsoft/playwright-mcp/issues/910, https://github.com/microsoft/playwright-mcp/issues/1177
- Playwright MCP #595, dialog blocks snapshot (hangs indefinitely) — https://github.com/microsoft/playwright-mcp/issues/595
- Playwright MCP #769, "Browser is already in use" profile lock — https://github.com/microsoft/playwright-mcp/issues/769
- Playwright MCP #893, parallel Claude Code agents fighting over one tab — https://github.com/microsoft/playwright-mcp/issues/893
- Playwright MCP #1294, isolated browser instances feature request — https://github.com/microsoft/playwright-mcp/issues/1294
- Playwright MCP #889, 6x token increase between versions — https://github.com/microsoft/playwright-mcp/issues/889
- Playwright MCP #915, optimize browser_snapshot / 5–10 step token limit — https://github.com/microsoft/playwright-mcp/issues/915
- Playwright core #14946, click actionability wait discussion — https://github.com/microsoft/playwright/issues/14946
- Chrome DevTools MCP #1152, intermittent tools/call timeout with healthy CDP — https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1152
- Chrome DevTools MCP #624, wait_for timeout capped at 30s — https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/624
- Chrome DevTools MCP troubleshooting doc (crash/timeout/session catalog) — https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md
- Puppeteer #13056, execution context destroyed, uncaught — https://github.com/puppeteer/puppeteer/issues/13056
- Puppeteer #4869, random execution-context-destroyed failures — https://github.com/GoogleChrome/puppeteer/issues/4869
- Puppeteer #10491, navigation failed / browser disconnected — https://github.com/puppeteer/puppeteer/issues/10491
- Puppeteer #2410, inconsistent text rendering in headless mode — https://github.com/puppeteer/puppeteer/issues/2410
- Chromium bug 744577, headless font rendering / line-break differences — https://bugs.chromium.org/p/chromium/issues/detail?id=744577
- browser-use #3972, agent doesn't wait for SPA content, retrieves null — https://github.com/browser-use/browser-use/issues/3972
- browser-use #1157, agent stuck in infinite Step-1 loop — https://github.com/browser-use/browser-use/issues/1157
- browser-use #1920, second agent breaks shared browser session — https://github.com/browser-use/browser-use/issues/1920
- Anthropic computer-use tool docs, "Understand computer use limitations" — https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- "Why Your AI Agent Says 'Done' But Nothing Actually Happened" — https://dev.to/eggp/why-your-ai-agent-says-done-but-nothing-actually-happened-1no3
- "Playwright and Chrome DevTools MCP: Driving vs. Debugging" (Steve Kinney) — https://stevekinney.com/writing/driving-vs-debugging-the-browser
- "Why less is more: The Playwright proliferation problem with MCP" (Speakeasy) — https://www.speakeasy.com/blog/playwright-tool-proliferation
- "Playwright MCP Burns 114K Tokens Per Test. The New CLI Uses 27K." — https://scrolltest.medium.com/playwright-mcp-burns-114k-tokens-per-test-the-new-cli-uses-27k-heres-when-to-use-each-65dabeaac7a0
- "Issue #4 — The Dark Mode Screenshot Debacle" — https://medium.com/@begunova/issue-4-the-dark-mode-screenshot-debacle-5221c7bec8b8
- "Layout Testing for Mobile Apps: What Breaks After Every UI Change" — https://www.drizz.dev/post/layout-testing-for-mobile-apps
- HMR-mid-agent-edit failure window — https://antigravitylab.net/en/articles/app-dev/antigravity-hmr-hot-reload-not-working-fix
- agent-browser-protocol README, "settled" step machine / virtual-time freeze — https://github.com/theredsix/agent-browser-protocol
- Vercel agent-browser README, daemon architecture / named sessions / refs — https://github.com/vercel-labs/agent-browser
- Cookie-consent automation workarounds (playwright-autoconsent context) — https://www.browserstack.com/guide/playwright-cookies
