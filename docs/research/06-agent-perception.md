# Research Brief 06 — How LLM Agents Best Perceive and Act on Web UIs

**Scope:** Literature review of web/GUI agent benchmarks and grounding research (2023–2026),
cross-checked against how production browser-automation tools actually ship in mid-2026,
synthesized into a recommended default observation format for **Glassbox** — a local,
CDP-owned Chromium daemon whose only client is a *coding agent verifying and debugging UI it
just wrote*, not a blind web-navigation agent.

---

## 1. Executive summary

The academic and production literature converges on one design, almost unanimously, for any
agent that has structured access to a page: **a compact accessibility-tree/DOM snapshot with
stable, per-snapshot numeric element references, screenshots attached only on demand.**
Raw HTML is rejected everywhere as too large (40K–500K tokens per WorkArena page ([arxiv.org/html/2605.29397](https://arxiv.org/html/2605.29397))); pure vision/coordinate grounding is rejected
everywhere it's avoidable as the least accurate, most expensive, and slowest path
(ScreenSpot-Pro's best model localizes UI elements only 18.9% of the time on real professional
software ([dl.acm.org/doi/10.1145/3746027.3755688](https://dl.acm.org/doi/10.1145/3746027.3755688))). Coordinate-based, screenshot-only control (Anthropic
computer use, OpenAI Operator/CUA) exists because those tools must work on *arbitrary desktop
GUIs with no accessible structure available* — that constraint does not apply to Glassbox,
which owns Chromium via CDP and therefore always has DOM + accessibility tree for free.

The single most important reframe for Glassbox's design comes from a paper most WebArena/
Mind2Web work treats as secondary: **"From Grounding to Planning: Benchmarking Bottlenecks in
Web Agents"** found that, contrary to the field's assumption, *grounding is not the dominant
failure mode for web agents — planning is* ([arxiv.org/abs/2409.01927](https://arxiv.org/abs/2409.01927)). Glassbox's client is a coding agent that
already did the planning (it wrote the code, it knows the intended selectors and structure);
the only job left is fast, cheap, reliable *observation* to confirm or refute what it believes
is true. This is a strictly easier and more constrained problem than what WebArena/Mind2Web/
OSWorld benchmark, and it argues for leaning even harder into structured, ref-based
observation than a general-purpose navigation agent would.

---

## 2. The benchmark landscape: what "perceiving a web UI" tasks actually measure

**WebArena / VisualWebArena.** WebArena (ICLR 2024) is a self-hosted, realistic multi-site
environment (e-commerce, forums, dev tools, CMS) where an LLM-driven agent completes long-
horizon tasks; the original GPT-4 reasoning-agent baseline scored a modest 10.63% end-to-end
success ([webarena.dev/static/paper.pdf](https://webarena.dev/static/paper.pdf)) — a reminder of how hard *planning* is even when grounding is
solved. VisualWebArena extended this with 910 tasks requiring genuine visual understanding
(image content, spatial layout) and introduced the **Set-of-Marks (SoM)** observation mode:
every interactable element gets a bounding box and an ID burned into the screenshot so a
vision model can reference "element 7" instead of describing it prose-style ([arxiv.org/html/2401.13649v2](https://arxiv.org/html/2401.13649v2)). Both benchmarks expose raw HTML, an accessibility tree, and screenshots as
alternative observation spaces to baseline agents against each other — the existence of that
three-way harness is itself evidence the field treats format choice as a first-class variable,
not an implementation detail.

**Mind2Web.** 2,350 tasks across 137 real (not sandboxed) websites, each action step grounded
against a real DOM snapshot. Its headline metric, *element accuracy* (did the agent pick the
right target node out of hundreds of candidates), sits around 50–53% for strong baselines,
with more recent reward-model pipelines pushing toward 88% when given a "perfect" high-level
sub-task decomposition first ([benchmarkingagents.com/mind2web](https://benchmarkingagents.com/mind2web/)). The gap between raw element accuracy and
the reward-model-assisted number is itself a planning artifact, not a grounding one — it
mirrors the Grounding-to-Planning paper's conclusion below.

**WebVoyager.** 643 tasks across 15 real sites (Amazon, Apple, Google Maps, ArXiv, etc.),
explicitly designed around **multimodal** large models. It formalized SoM as the default
action-grounding interface for screenshot-driven agents and uses GPT-4V itself as an automatic
judge of task completion ([arxiv.org/html/2401.13919v3](https://arxiv.org/html/2401.13919v3), [aclanthology.org/2024.acl-long.371](https://aclanthology.org/2024.acl-long.371/)).

**OSWorld / OSWorld-Verified.** The desktop analogue: 369+ real tasks across Ubuntu/Windows/
macOS apps, no DOM available at all (this is the *only* environment among these benchmarks
where screenshot-only perception is not a choice but a necessity, because most native desktop
apps expose no usable accessibility API). Progress here has been the field's most dramatic
story: from ~20% success a year prior, Simular's Agent S crossed the **72.36% human baseline**
in December 2025 ([simular.ai/articles/simulars-computer-use-agent-outperforms-humans](https://www.simular.ai/articles/simulars-computer-use-agent-outperforms-humans); [github.com/xlang-ai/OSWorld](https://github.com/xlang-ai/osworld)). Efficiency studies on the
same benchmark found the best agents still take 2.7–4.3× more steps than a human needs, and
each successive step gets ~3× slower as trajectories lengthen — a latency tax that is a direct
consequence of screenshot-centric perception loops, not of the underlying task difficulty
([arxiv.org/abs/2506.16042](https://arxiv.org/abs/2506.16042)).

**ScreenSpot / ScreenSpot-Pro.** Pure grounding benchmarks (given an instruction + screenshot,
output the coordinate of the target element, no navigation). ScreenSpot-Pro deliberately uses
high-resolution professional software where target elements average **0.07% of image area**
versus 2.01% on mainstream ScreenSpot — and even the best specialized grounding model manages
only 18.9% ([dl.acm.org/doi/10.1145/3746027.3755688](https://dl.acm.org/doi/10.1145/3746027.3755688)). This is the strongest single data point against relying on
coordinate-based visual grounding as a default for anything with fine-grained targets — exactly
the regime of dense app UI (nav bars, icon buttons, form fields) that a coding agent is
verifying.

---

## 3. Grounding strategies, head to head

The most direct controlled comparison is **SeeAct** ("GPT-4V(ision) is a Generalist Web Agent,
if Grounded"), which tested the *same* underlying model (GPT-4V) against three different
grounding interfaces on the same tasks:

1. **Attribute-based** — model states element type + visible text, heuristically matched to DOM.
2. **Textual choice** — candidate elements ranked (CrossEncoder), presented as a lettered
   multiple-choice list with HTML snippets; model picks "A"/"B"/etc.
3. **Image annotation (SoM-style)** — candidates get numbered bounding boxes on the screenshot.

**Textual choice won by a wide margin**, beating both attribute-based and pure image-annotation
grounding, though even the best strategy still had a 20–25 percentage-point gap versus oracle
(perfect) grounding ([arxiv.org/pdf/2401.01614](https://arxiv.org/pdf/2401.01614); [osu-nlp-group.github.io/SeeAct](https://osu-nlp-group.github.io/SeeAct/)). The pattern generalizes: whenever a *symbolic
handle* (a ref, a numbered choice, an ID) rather than a *raw pixel coordinate* is what the model
has to produce, accuracy goes up, because next-token prediction over a small discrete label
space is a far easier generation task for an LLM than emitting a numerically precise (x, y)
pair.

Coordinate-based clicking still dominates in exactly one place: general computer-use agents
(Operator/CUA, Claude computer use, Project Mariner) that must work across arbitrary,
non-web, non-instrumented GUIs where no structured element list exists at all. There,
coordinates are the only available action space — not the best one.

---

## 4. The reframe: grounding is not the bottleneck — planning is

"From Grounding to Planning: Benchmarking Bottlenecks in Web Agents" decomposed Mind2Web
agent failures into a planning component (deciding *what* to do next) and a grounding
component (deciding *which element* executes that decision), and benchmarked them
independently rather than as one opaque end-to-end number. Its central, field-contrarian
finding: **"grounding is not a significant bottleneck and can be effectively addressed with
current techniques… the primary challenge lies in the planning component"** ([arxiv.org/abs/2409.01927](https://arxiv.org/abs/2409.01927)).

This matters enormously for Glassbox's product shape. WebArena/Mind2Web/OSWorld agents are
blind navigators: they've never seen the page before, don't know its structure, and have to
*plan* a multi-step strategy toward an ambiguous goal ("book the cheapest flight") while
simultaneously grounding each step. Glassbox's client is categorically different: it is the
same coding agent that wrote the JSX/HTML in the first place. It already knows the DOM
structure, the CSS selectors, the component hierarchy, and the exact change it just made. Its
"planning" problem is trivial or already solved (it has a specific hypothesis: "the button I
added should now say X" or "this component should not overflow"). What it actually needs from
Glassbox is a *fast, cheap, low-noise confirmation channel* — which is precisely the part the
literature says is easy to build well, provided the observation format is structured rather
than pixel-based.

---

## 5. Ablation evidence: DOM vs. accessibility tree vs. screenshot

Several independent lines of evidence converge on accessibility-tree-first, screenshot-second:

- **Token cost.** Raw HTML on WorkArena-scale pages runs 40K–500K tokens ([arxiv.org/html/2605.29397](https://arxiv.org/html/2605.29397)). The
  accessibility tree of the same page is commonly ~5,000 tokens, and filtered to
  interactive-only elements, ~1,000–3,000 tokens — a 96%+ reduction, independently reported
  by both a production Claude/MCP token-optimization case study (single click: 125,000 tokens
  HTML vs. 600 tokens accessibility-tree+ref, a 99.5% cut) and multiple browser-automation
  tool vendors ([iron-mind.ai/blog/claude-mcp-browser-automation-token-optimization](https://iron-mind.ai/blog/claude-mcp-browser-automation-token-optimization); [dev.to/kuroko1t](https://dev.to/kuroko1t/how-accessibility-tree-formatting-affects-token-cost-in-browser-mcps-n2a)).
- **Screenshot cost.** A single vision-model screenshot commonly runs 3,000–15,000+ tokens
  depending on resolution ([ytyng.com AI browser automation token benchmark 2026](https://www.ytyng.com/en/blog/ai-browser-automation-tools-comparison-2026); zylos.ai state-of-the-art review), before any
  reasoning tokens are spent interpreting it — meaning even a "cheap" screenshot loop usually
  costs more than a full structured snapshot.
- **Marginal accuracy gain from adding vision.** A controlled comparison on Gemini 2.5 Flash
  found that adding screenshots on top of accessibility-tree observations *did not
  significantly change* task success or benign utility ([arxiv.org/html/2605.29397](https://arxiv.org/html/2605.29397)). A parallel mobile-agent study
  ("Do LLMs Need to See Everything?", DailyDroid benchmark) comparing UI-tree text
  ("screentext") against text+screenshot across GPT-4o and o4-mini found only **marginally
  higher** success with the multimodal input, not a step change ([arxiv.org/pdf/2604.17817](https://arxiv.org/pdf/2604.17817)).
- **When pruning the DOM/tree matters.** "Revisiting Observation Reduction for Web Agents"
  benchmarked 11 different HTML/DOM reduction strategies (heuristic pruning, BM25/embedding
  retrieval, LLM-based selection, accessibility-tree extraction) and found the *right* amount
  of pruning is task- and site-dependent — some sites need text content preserved, others need
  `id`/`class` attributes preserved for later selector construction — and that naive
  accessibility-tree-only pruning can silently drop information a later step needs
  ([arxiv.org/html/2605.29397](https://arxiv.org/html/2605.29397)). This is the one ablation result that argues *against* a pure
  accessibility-tree default with no fallback: Glassbox should keep raw DOM access one call
  away, not throw it away entirely.

---

## 6. What production tools already converged on (2025–2026)

Independent of the academic benchmarks, essentially every browser-automation tool built for
LLM coding agents in the last 18 months has converged on the same shape, which strongly
validates (and de-risks) Glassbox's core hypotheses:

- **Playwright MCP** (Microsoft) — "*Uses Playwright's accessibility tree, not pixel-based
  input*." `browser_snapshot` returns a structured text tree; every interactive node gets a
  stable `ref` (e.g. `[ref=e5]`) that later `click`/`type` calls target directly.
  **Refs are explicitly scoped to one snapshot** and go stale the instant the DOM changes —
  the docs' hard rule is "always re-snapshot after a navigation, click, or any action that
  might change the DOM." Their own numbers: ~200–400 tokens for a snapshot vs. ~3,000–5,000
  for an equivalent screenshot ([playwright.dev/mcp/snapshots](https://playwright.dev/mcp/snapshots); [github.com/microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)). Their guidance
  explicitly recommends **combining** a snapshot with a screenshot only for "canvas apps,
  charts, image-heavy layouts" — i.e., exactly the content classes where structure alone is
  insufficient.
- **Chrome DevTools MCP** (Google/ChromeDevTools team) — `take_snapshot` returns an
  accessibility-tree-derived text view with a **unique `uid` per element**, reused by `click`/
  `fill`/other interaction tools "without requiring re-querying the DOM." Canonical loop
  documented in their own skill file: **Navigate → Wait → Snapshot → Interact** ([github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)).
- **Stagehand** (Browserbase) — started on raw DOM parsing, migrated to Chrome's
  accessibility tree specifically because it is more stable under visual/layout churn and
  because it filters "unnecessary noise," cutting payload size 80–90% vs. raw DOM. It
  additionally composes a **hybrid DOM+a11y structure** (not pure a11y) to recover
  interactive elements the accessibility API alone under-reports, and separately resolves
  iframes by computing absolute XPaths per frame ([memo.d.foundation/breakdown/stagehand](https://memo.d.foundation/breakdown/stagehand); [browserbase.com/blog/ai-web-agent-sdk](https://www.browserbase.com/blog/ai-web-agent-sdk)).
- **browser-use**, **PinchTab**, **agent-browser** (Vercel) — all converge on the same
  compressed-tree-plus-numeric-ID pattern; a head-to-head write-up testing every major tool
  against Claude Code found the accessibility-tree tool (~800 tokens/interaction, `e5`-style
  numeric refs) the daily-driver winner, with screenshot/video tools relegated to a fallback
  tier for cases needing visual proof ([dev.to/minatoplanb, "I Tested Every Browser Automation Tool for Claude Code"](https://dev.to/minatoplanb/i-tested-every-browser-automation-tool-for-claude-code-heres-my-final-verdict-3hb7)).
- **VS Code's native agent browser tools** (2026) expose `readPage` (structured/DOM),
  `screenshotPage`, and element-action tools (`clickElement`, `dragElement`, etc.) as
  complementary, not competing, primitives — screenshots for "does this look right," DOM
  reads for "why doesn't it look right" ([code.visualstudio.com/docs/agents/guides/browser-agent-testing-guide](https://code.visualstudio.com/docs/agents/guides/browser-agent-testing-guide)).
- The **Tweag Agentic Coding Handbook**'s visual-feedback-loop guidance states the same split
  explicitly for coding agents: screenshots for spotting *that* something is visually wrong
  (misalignment vs. a design reference), structured MCP/DOM data for *root-causing why*
  (overlapping margin, failed request) — and stresses that an agent which authored the code
  should exploit that implementation knowledge to jump straight to root cause rather than
  re-discovering structure from pixels ([tweag.github.io/agentic-coding-handbook/WORKFLOW_VISUAL_FEEDBACK](https://tweag.github.io/agentic-coding-handbook/WORKFLOW_VISUAL_FEEDBACK/)).

No tool in this survey defaults to screenshot-first for a coding-agent workflow. The unanimous
default is structured/ref-based; screenshots are the escalation path.

---

## 7. Anthropic computer use & OpenAI CUA: a different problem, useful lessons anyway

Anthropic's computer-use tool and OpenAI's Operator/CUA solve a harder, more general problem
than Glassbox needs to: driving *any* GUI, including native desktop apps with no accessible
structure, so they are architecturally committed to screenshot + coordinate action, and their
documented lessons are mostly about the failure modes of that specific choice:

- **Pixel-counting is a trained skill, not an emergent one.** Anthropic explicitly trained
  Claude to count pixel offsets for cursor placement, comparing it to arithmetic sub-skills
  like counting letters — without that training, coordinate accuracy was poor
  ([anthropic.com/news/developing-computer-use](https://www.anthropic.com/news/developing-computer-use)).
- **Perception is a "flipbook," not a video stream** — sequential screenshots, which
  Anthropic notes "can miss short-lived actions or notifications" ([anthropic.com/news/developing-computer-use](https://www.anthropic.com/news/developing-computer-use)). Any
  screenshot-only observation channel inherits this staleness/race-condition risk; a
  console/network event log (which Glassbox's bundle already plans to capture) closes exactly
  this gap without needing higher screenshot frequency.
- **Certain interactions remained hard well past initial release**: scrolling, dragging,
  zooming were named as weak points at launch (Oct 2024) ([anthropic.com/news/3-5-models-and-computer-use](https://www.anthropic.com/news/3-5-models-and-computer-use)); by the
  `computer-use-2025-11-24` tool version Anthropic had added scroll-amount control,
  click-drag, and a dedicated "zoom into region at full resolution" action specifically to
  compensate for coordinate-grounding limitations at low apparent resolution ([platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)) — i.e.,
  two full tool-generations were spent patching problems that simply don't exist if you have
  DOM/accessibility access to begin with.
- **Trajectory**: OSWorld score moved from 14.9% (Claude 3.5 Sonnet, screenshot-only, Oct
  2024) to over 72% (Sonnet 4.6, Dec 2025) ([anthropic.com/news/3-5-models-and-computer-use](https://www.anthropic.com/news/3-5-models-and-computer-use); OSWorld leaderboard reporting). That is genuine
  progress on the hard, structure-free problem — but it took 14 months of dedicated model
  training to close a gap that a DOM-native tool sidesteps for free on day one.
- **OpenAI's Operator/CUA** runs the identical perceive→reason→act screenshot loop
  ("incorporating screenshots into the model's context… coordinate-based clicking, scrolling,
  typing") for the same reason: it targets arbitrary GUIs, web and non-web ([openai.com/index/introducing-operator](https://openai.com/index/introducing-operator/); [openai.com/index/operator-system-card](https://openai.com/index/operator-system-card/)).
- By contrast, **Gemini Computer Use** already blends "DOM structure, accessibility tree, and
  browser-native events where available" on top of the screenshot loop specifically to claw
  back the accuracy general vision-coordinate grounding gives up on web workflows
  ([digitalapplied.com/blog/computer-use-agents-2026-claude-openai-gemini-matrix](https://www.digitalapplied.com/blog/computer-use-agents-2026-claude-openai-gemini-matrix)) — further evidence that even the general
  computer-use vendors treat DOM/a11y-tree access as strictly better *whenever it's available*,
  which for Glassbox it always is.

**Implication for Glassbox:** none of Glassbox's target workflows require solving the
structure-free GUI problem Anthropic/OpenAI spent over a year of RL training on. Glassbox
should not build (or need) a coordinate-grounding model at all as its primary path — it should
inherit CDP's native DOM + accessibility access and only fall back to coordinate/vision actions
for the narrow slice of content that is genuinely unstructured (canvas, WebGL, custom-drawn
components, cross-origin iframe content CDP can't reach).

---

## 8. A caveat specific to Glassbox: the pages under test may have bad accessibility trees

Every production tool above is implicitly relying on the target site having a *reasonably
well-formed* accessibility tree — true for most public production sites with SEO/a11y
investment, but **not guaranteed for a work-in-progress app a coding agent is actively
building.** The accessibility literature is blunt about how easy this is to get wrong: click
handlers bound to non-semantic `<div>`s silently strip built-in keyboard support, focus
behavior, and ARIA roles; visual state changes (`expanded`, `selected`, `active`) frequently
never make it into the corresponding ARIA attributes in React/Vue/Angular apps; and malformed
ARIA relationships (`aria-labelledby` pointing at nothing, roles missing required
parents/children) get flagged by tools like Lighthouse as producing a tree that isn't
well-formed at all ([browserstack.com/guide/react-accessibility](https://www.browserstack.com/guide/react-accessibility/); [webyes.com/blogs/accessibility-tree-is-not-well-formed-fix](https://www.webyes.com/blogs/accessibility-tree-is-not-well-formed-fix/); [accesify.io/blog/accessibility-single-page-apps-react](https://www.accesify.io/blog/accessibility-single-page-apps-react/)).

This is not a hypothetical edge case for Glassbox — it is close to the *modal* case, since the
whole point of the tool is verifying UI a coding agent just wrote, which is disproportionately
likely to be a half-finished component with no `aria-label` yet. A pure accessibility-tree
default (à la Playwright MCP) risks the tool being systematically blind to exactly the
newest, least-tested part of the page — the part most likely to contain the bug. This argues
for Glassbox to build its default snapshot from **raw CDP DOM + computed accessibility
properties merged**, not from the browser's accessibility tree alone (mirroring Stagehand's
hybrid rationale, §6), and to run/report accessibility *violations themselves* as a first-class
part of the verification bundle rather than silently degrading when a node lacks a role/name.

---

## 9. Forward look: agent-native web is arriving, but doesn't help Glassbox yet

2025–2026 saw real movement toward sites exposing structure *for* agents rather than agents
inferring it: **llms.txt** (a static Markdown summary of a site's key content, adopted by
Anthropic, Cloudflare, Docker, HubSpot and others) and **WebMCP** (a W3C Community
Group-backed, Google/Microsoft co-authored standard letting a page register real, callable,
in-browser tools for an agent — moved from a Chrome 146 flag to a public origin trial across
Chrome 149–156 as of June 2026) ([webmcp.md](https://www.webmcp.md/); [wellknownmcp.org, "The Complete Agentic Web Standards Map 2026"](https://wellknownmcp.org/en/news/2026-02-15-agentic-web-standards-map-2026-complete-guide)). These target *production
sites agents don't control* — a different problem from Glassbox's, where the "site" is local,
under active construction, and owned by the very agent doing the verifying. The interesting
implication isn't that Glassbox should consume WebMCP (there's nothing to consume on a
localhost dev server yet) but that it validates the same architectural bet from the opposite
direction: even the browser-standards community has concluded that DOM-scraping/vision
inference is a stopgap and *structured, stable, tool-callable references* are where agent-page
interaction is headed. Glassbox's ref-based snapshot model is that same idea, just generated
locally by the daemon instead of published by the site.

---

## 10. Synthesis — what Glassbox's default observation format should be

**Default: a structured DOM + accessibility snapshot, not a screenshot, not raw HTML.**
Every line of evidence above — token cost (96–99% smaller than raw HTML), accuracy (textual/
ref-based grounding beats coordinate and image-annotation grounding in the one controlled
head-to-head that measured all three), and unanimous production convergence (Playwright MCP,
Chrome DevTools MCP, Stagehand, browser-use, VS Code's own agent tools) — points the same
direction. Concretely:

- Build the snapshot from **CDP's `DOM.getDocument` + `Accessibility.getFullAXTree`, merged**,
  not from the accessibility tree alone (§8) — an element with no accessible name should still
  appear, flagged as such, rather than silently vanish.
- **Number every actionable/inspectable node with a stable, per-snapshot integer ref** (the
  Playwright/Chrome-DevTools-MCP `e5`/`uid` pattern), backed internally by the CDP
  `backendNodeId` so the same handle can be cross-referenced from console errors, network
  requests tied to that element, and layout/computed-style data in the same bundle. **Refs must
  be explicitly invalidated on any DOM mutation** and the daemon should force a re-snapshot
  before honoring an action against a stale ref, exactly as Playwright MCP's docs mandate —
  this is the one sharp edge every production tool independently rediscovered.
- **Because Glassbox's client wrote the code, accept the agent's own selector as an
  equally-valid grounding path alongside the numeric ref** — this is a genuine departure from
  every benchmark surveyed (WebArena/Mind2Web/SeeAct agents have no selector to offer; they
  must resolve one from scratch). A coding agent asking "click the element matching
  `[data-testid=submit-btn]`" is asking a strictly easier and more verifiable question than
  "click element 7" from a snapshot it hasn't seen yet, and Glassbox should let it skip the
  snapshot round-trip when it already knows the target. Grounding is cheap here in a way the
  literature never gets to assume.
- **Screenshots are an on-demand attachment, not the default per-step observation.** The
  literature is consistent that vision adds cost without reliably adding accuracy when
  structure is available (Gemini 2.5 Flash AXTree+screenshot ablation showing no significant
  change; DailyDroid's "marginal" multimodal gain). Reserve screenshots (full-page and/or
  targeted-region) for the cases the a11y/DOM tree structurally cannot answer: pixel-level
  layout/overflow/spacing bugs, visual regression diffing across a change, canvas/WebGL/chart
  content, and CSS cascade effects that only manifest visually (z-index stacking, clipping,
  color contrast). This maps directly onto Glassbox's planned "cascade introspection" and
  "layout" bundle members — those should trigger a screenshot; a console-error check should
  not.
- **Coordinate-based clicking is a last-resort fallback only**, gated to content CDP can't
  otherwise reach (canvas-drawn UI, custom-cursor games, cross-origin iframes without
  cooperative access) — never the default action-grounding path. The ScreenSpot-Pro number
  (18.9% best-in-class on dense professional UI) and the SeeAct comparison (image-annotation
  losing to textual-choice grounding) both argue this is the least reliable option available
  whenever a better one exists, and for Glassbox a better one (DOM ref, agent's own selector)
  almost always exists.
- **The one-call verification bundle should default to text**: console + network + a11y-tree
  (with violations flagged, not hidden) + computed layout, sized closer to a git diff than a
  screenshot. Attach a screenshot automatically only when the bundle detects something a
  structured signal can't fully explain (e.g., a layout-shift/overflow signal with no
  corresponding DOM change) or when the agent explicitly asks for visual confirmation.

---

## Surprises (vs. first-principles priors)

- **Grounding is not the hard part of web agency — planning is** ([arxiv.org/abs/2409.01927](https://arxiv.org/abs/2409.01927)). This
  is good news shaped like a threat to Glassbox's premise: if grounding were the bottleneck,
  a better grounding model would be Glassbox's core IP. It isn't — Glassbox's client has
  already solved planning by construction (it wrote the code), so the product's value has to
  come from speed/determinism/session-management/white-box hooks, not from out-competing
  SeeAct/UI-TARS-style grounding research.
- **Adding screenshots to an already-good structured observation barely moves accuracy** in
  the two controlled ablations found (Gemini 2.5 Flash AXTree-vs-AXTree+screenshot; DailyDroid
  screentext-vs-multimodal) — this cuts against an intuition that "more modalities is strictly
  safer."
- **Vision grounding on real, dense professional UI is still bad** (18.9% best on
  ScreenSpot-Pro) even as OSWorld's *end-to-end* screenshot-driven agents crossed human parity
  in the same period — the two facts look contradictory until you notice OSWorld success
  leans on many *retries and self-correction steps* per the OSWorld-Human efficiency study
  (2.7–4.3× more steps than needed), i.e. screenshot-coordinate agents compensate for weak
  single-shot grounding with expensive iteration, which Glassbox doesn't need to inherit.
- **Every production browser-automation tool aimed at coding agents had already converged on
  Glassbox's core hypothesis (daemon + CDP + numbered a11y refs + on-demand screenshots)
  before this review started** — Playwright MCP, Chrome DevTools MCP, Stagehand, and several
  smaller tools (PinchTab, agent-browser) are functionally doing pieces of what Glassbox
  proposes today. This means Glassbox's differentiation cannot be "better default observation
  format" alone — that space is already crowded and mostly solved — it has to be the
  higher-order features the hypothesis list names (named parallel isolated sessions, one-call
  bundles that *include* a11y+console+network+layout+screenshots together rather than as
  separate tool calls, deep white-box hooks like breakpoints/coverage/cascade introspection,
  and human ride-along) where no single surveyed tool goes as far.

---

## Sources

- WebArena paper (ICLR 2024): https://webarena.dev/static/paper.pdf
- VisualWebArena paper: https://arxiv.org/html/2401.13649v2
- Mind2Web summary/metrics: https://benchmarkingagents.com/mind2web/
- WebVoyager paper (ACL 2024): https://arxiv.org/html/2401.13919v3 / https://aclanthology.org/2024.acl-long.371/
- OSWorld GitHub (NeurIPS 2024): https://github.com/xlang-ai/osworld
- OSWorld-Human efficiency study: https://arxiv.org/abs/2506.16042
- Simular Agent S surpasses human baseline on OSWorld: https://www.simular.ai/articles/simulars-computer-use-agent-outperforms-humans
- ScreenSpot-Pro benchmark (ACM MM 2025): https://dl.acm.org/doi/10.1145/3746027.3755688
- Set-of-Mark Prompting (GPT-4V), Yang et al.: https://arxiv.org/abs/2310.11441
- SeeAct / "GPT-4V(ision) is a Generalist Web Agent, if Grounded": https://arxiv.org/pdf/2401.01614 / https://osu-nlp-group.github.io/SeeAct/
- "From Grounding to Planning: Benchmarking Bottlenecks in Web Agents": https://arxiv.org/abs/2409.01927
- "Revisiting Observation Reduction for Web Agents": https://arxiv.org/html/2605.29397
- "Do LLMs Need to See Everything?" (DailyDroid, screentext vs screenshot): https://arxiv.org/pdf/2604.17817
- UI-TARS paper: https://arxiv.org/abs/2501.12326 / https://github.com/bytedance/UI-TARS
- Anthropic — Introducing computer use (Claude 3.5 Sonnet/Haiku): https://www.anthropic.com/news/3-5-models-and-computer-use
- Anthropic — Developing computer use (research process, pixel-counting, flipbook screenshots): https://www.anthropic.com/news/developing-computer-use
- Claude computer use tool docs (2025-11-24 tool version): https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- OpenAI — Introducing Operator: https://openai.com/index/introducing-operator/
- OpenAI — Operator System Card: https://openai.com/index/operator-system-card/
- Claude vs OpenAI vs Gemini computer-use comparison (2026): https://www.digitalapplied.com/blog/computer-use-agents-2026-claude-openai-gemini-matrix
- Playwright MCP GitHub (Microsoft): https://github.com/microsoft/playwright-mcp
- Playwright MCP snapshots documentation: https://playwright.dev/mcp/snapshots
- Chrome DevTools MCP tool reference (uid/snapshot pattern): https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md
- browser-use GitHub: https://github.com/browser-use/browser-use
- Stagehand breakdown (DOM+a11y hybrid): https://memo.d.foundation/breakdown/stagehand
- Stagehand / Browserbase blog: https://www.browserbase.com/blog/ai-web-agent-sdk
- Accessibility-tree token cost in browser MCPs: https://dev.to/kuroko1t/how-accessibility-tree-formatting-affects-token-cost-in-browser-mcps-n2a
- "Why Your Browser Automation Is Breaking: The DOM Is Too Big for AI": https://www.dozaldevs.com/blog/why-your-browser-automation-is-breaking-the-dom-is-too-big-for-ai
- Claude MCP browser automation token optimization case study: https://iron-mind.ai/blog/claude-mcp-browser-automation-token-optimization
- "I Tested Every Browser Automation Tool for Claude Code": https://dev.to/minatoplanb/i-tested-every-browser-automation-tool-for-claude-code-heres-my-final-verdict-3hb7
- AI browser automation tools token benchmark (2026): https://www.ytyng.com/en/blog/ai-browser-automation-tools-comparison-2026
- VS Code agent browser testing guide: https://code.visualstudio.com/docs/agents/guides/browser-agent-testing-guide
- Tweag Agentic Coding Handbook — visual feedback loop: https://tweag.github.io/agentic-coding-handbook/WORKFLOW_VISUAL_FEEDBACK/
- Computer-use/GUI-agent state of the art, Feb 2026 (Zylos Research): https://zylos.ai/research/2026-02-08-computer-use-gui-agents/
- React accessibility issues (ARIA state sync, div soup): https://www.browserstack.com/guide/react-accessibility/
- "Accessibility Tree Is Not Well-Formed — How to Fix It": https://www.webyes.com/blogs/accessibility-tree-is-not-well-formed-fix/
- SPA/React accessibility (focus, routing, ARIA): https://www.accesify.io/blog/accessibility-single-page-apps-react/
- WebMCP.md — the web standard agents can operate directly: https://www.webmcp.md/
- The Complete Agentic Web Standards Map 2026 (WebMCP, MCP, LLMFeed): https://wellknownmcp.org/en/news/2026-02-15-agentic-web-standards-map-2026-complete-guide
