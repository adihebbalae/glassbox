# Landscape: Browser Tools Built for AI Agents (mid-2026)

Research pass for Glassbox — a hypothesized local daemon that owns a Chromium instance via
CDP, exposes named/parallel isolated sessions, speaks MCP *and* CLI, returns one-call
verification bundles (console+network+a11y+layout+screenshots), supports white-box debugging
(breakpoints, coverage, cascade introspection), allows human ride-along viewing, and writes
all artifacts to disk. This report surveys the field as of July 2026 and evaluates every
entrant against the specific job: **a coding agent (Claude Code) verifying and debugging its
own localhost UI changes.**

## 1. MCP browser servers (agent-facing dev tools)

### microsoft/playwright-mcp
Official Microsoft MCP server wrapping Playwright. Apache-2.0, npm (`@playwright/mcp@latest`)
and Docker distribution, ~33.5k stars, actively released. Drives Chromium/Firefox/WebKit over
Playwright's own CDP layer, defaulting to a **persistent local profile** (so login state
survives across runs) but supporting `--isolated` ephemeral contexts, direct CDP-endpoint
connection to an already-running browser, or attaching to live tabs via a browser extension.
Uses the accessibility tree for element targeting rather than pixel coordinates — "vision
mode" is opt-in. Exposes 50+ tools: navigation/input, tab management, opt-in network
interception/mocking, opt-in storage (cookies/localStorage) access, opt-in DevTools features
(video/trace recording, element highlighting, step-through), and opt-in vision-based clicking.
**Session model is the load-bearing weakness**: the README states outright that "a persistent
profile can only be used by one browser instance at a time, so concurrent MCP clients sharing
the same workspace will conflict." Practical fix is per-client `--user-data-dir` or
`--isolated`. Confirmed in the wild: [issue #893](https://github.com/microsoft/playwright-mcp/issues/893)
reports that multiple parallel Claude Code agents against one playwright-mcp server "fight
over the same tab in the same browser window," give non-reproducible results launched in
parallel vs. sequentially, and the open ask — "add a tab index as a parameter" — is
unresolved. This is the single clearest piece of evidence that today's dominant MCP browser
server does not support Glassbox's "named parallel isolated sessions" hypothesis out of the
box; users patch around it with one MCP server process per agent/worktree.
Fit for the job: strong on raw automation breadth, weak on concurrency and on bundling
verification signals into one call (console, network, tracing are separate tool calls you
must orchestrate yourself).

### ChromeDevTools/chrome-devtools-mcp (Google, official)
Google's own MCP server, distinct from playwright-mcp, built on Puppeteer/CDP specifically to
expose **Chrome DevTools** (not generic automation) to agents. Apache-2.0, ~47.4k stars, v1.6.0
as of July 2026, 108 contributors, actively released (57 releases), TypeScript. This is the
closest existing thing to Glassbox's "verification bundle" hypothesis: 31 tools across input,
navigation, emulation, **performance** (trace recording + Lighthouse-style actionable
insights), **network** inspection, **debugging** (script eval, console, screenshots, DOM
snapshots, screencasting), **memory** (heap snapshots/diffs), and extension management.
Community/roadmap issues show active work on exactly Glassbox's white-box list: computed
styles ([issue #86](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/86)), CSS
coverage tracking ([issue #731](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/731)),
and cascade/specificity resolution — but these are recent/partial, not a mature, stable "one
call gets you console+network+a11y+layout+screenshot" bundle; an agent still issues 4-6
separate tool calls and assembles the picture itself. Session model: **single persistent
browser instance by default**; concurrent sessions need the experimental
`--experimentalPageIdRouting` flag to route calls by `pageId` — again, parallelism is bolted
on, not designed in. Launch modes: auto-launch with a dedicated cached profile, auto-connect
to an already-running Chrome 144+, or manual `--browser-url`/WebSocket connection; `--isolated`
gives disposable per-run profiles. Google positioned this hard at I/O 2026 as the agent-facing
DevTools surface — "available today across Antigravity and 20+ coding agents," with LY
Corporation citing a 96-98% reduction in manual perf-analysis effort. Officially supports only
Google Chrome and Chrome for Testing.
Fit for the job: best-in-class breadth of white-box signal (perf traces, memory, console,
network, Lighthouse) explicitly aimed at coding agents, but single-instance-by-default and no
native session naming; still MCP-only (no CLI), and no built-in "everything to disk"
artifact contract — screenshots/traces go where you tell each tool to put them, not a
uniform session directory.

### Cloudflare Browser Rendering (Playwright MCP + Stagehand)
Cloudflare's managed headless-Chromium-on-the-edge product now ships an official Playwright
MCP server (GA, synced to Playwright v1.55) and beta Stagehand support, addressable via REST
API or Workers bindings, with tripled rate limits on paid plans as of mid-2026. This is cloud
infra wearing an MCP interface — useful for scaled scraping/testing fleets, not for a
developer's own localhost, since the browser runs on Cloudflare's network, not the machine
running the code under test (it cannot reach `localhost:3000` on the developer's box without a
tunnel).

### puppeteer-mcp (community; original deprecated)
Anthropic's original reference Puppeteer MCP server has been deprecated; the space is now a
long tail of community forks (`Xandon/puppeteer-mcp-server`, `sultannaufal/puppeteer-mcp-server`
with SSE + Docker, `merajmehrabi/puppeteer-mcp-server` for attaching to existing Chrome windows,
Python/Playwright ports, etc.). None has consolidated as a de facto standard the way
playwright-mcp and chrome-devtools-mcp have; they're small, single-maintainer, and mostly
re-implement a subset of what the two official servers already do.

## 2. CLI-first browser tools for agents

### vercel-labs/agent-browser
A native Rust CLI from Vercel Labs, explicitly designed to be **easier for a model to reason
about than an MCP tool list**: one executable, explicit subcommands (`open`, `snapshot -i`,
`click @e1`, `fill @e2`, `screenshot`, `wait`), accessibility-tree snapshots with compact
`@eN` element refs instead of brittle selectors, and `--auto-connect` to reuse an existing
logged-in Chrome session. It *also* runs as an MCP server over stdio (JSON-RPC) for clients
that want that interface, so it's CLI-first but not CLI-only. Works with Claude Code, Codex,
Cursor, Gemini CLI, Copilot, Goose, OpenCode, Windsurf. A companion write-up
([bitbasti.com](https://bitbasti.com/blog/moving-toward-code-based-agents-agent-browser-cli-workflows))
argues the CLI pattern beats MCP-tool-list ergonomics on token overhead and "execution
clarity," citing Vercel's own finding of removing "80% of agent tools" via consolidation.
Provider docs list pluggable engines (Chrome, Lightpanda) and pluggable cloud backends
(Browserbase, Browser Use Cloud, Browserless, Kernel, AWS Bedrock AgentCore). This is
architecturally the nearest published analogue to Glassbox's CLI-interface hypothesis, but it
is a per-invocation automation tool, not a persistent daemon with named sessions — there's no
concept of "session `pr-42`" you can address across calls beyond `--auto-connect`'s single
shared Chrome instance, and it carries none of chrome-devtools-mcp's performance/memory/
coverage tooling.

### browser-use/browser-harness
MIT-licensed, ~15k+ stars, ~592 lines of Python: "a thin, editable CDP harness that connects
an LLM directly to a real browser... one websocket to Chrome, nothing between." Explicitly
**screenshot-first** (screenshot → identify coordinates → click → screenshot to verify) rather
than accessibility-tree-first, and **self-healing**: when the agent hits a missing capability
mid-task (e.g., file upload) it edits the harness's own Python in place to add the function,
no human intervention required. Ships as a Claude Code/Codex "skill" (paste-and-register
workflow) rather than a background service. This is a real, separately-maintained project
(not to be confused with any private tooling) and is philosophically close to Glassbox's
"thin CDP ownership" instinct, but it is single-session, has no MCP interface, no
console/network/a11y/layout bundle, no breakpoints/coverage, and no ride-along viewing model
beyond whatever window is already visible — it optimizes for adaptability over structured,
repeatable verification output.

## 3. Agent frameworks / libraries (drive-the-browser SDKs)

### browser-use/browser-use
MIT, ~106k stars, 133 releases, v0.13.6 (July 2026) — the most-starred project in this space.
Python library that runs an agent loop (observe page state → pick action → execute via
Playwright → repeat) with a CLI (`browser-use skill install` lets Claude Code/Cursor/Hermes
call it conversationally) and an MCP registry entry. Claims #1 on the "Odysseys" long-horizon
task leaderboard (87.4% on 200 tasks). **Browser Use Cloud** is the hosted counterpart: free
tier capped at 3 concurrent sessions, paid tiers scale "parallel execution," plus stealth,
proxy rotation, and CAPTCHA solving. A sibling repo, `browser-use/browsercode`, is described as
"the browser-native agent framework" — a fork of OpenCode vendoring a TypeScript port of
Browser Harness — indicating the org is converging its CLI-coding-agent and browser-harness
lines. Fit: task-completion-oriented (get X done on a live site), not verification-oriented;
no purpose-built debugging bundle.

### browserbase/stagehand
MIT, ~23.6k stars, 77 releases, built directly on Playwright. Four primitives — `act()`,
`extract()` (Zod-schema-typed), `observe()`, `agent()` — let natural language and code
interleave in the same script; auto-caching/self-healing means a successful `act()` call is
remembered and replayed without another LLM call unless the page changes. TypeScript SDK
(`@browserbasehq/stagehand`), Python port, and an MCP server. Tightly coupled to **Browserbase**
cloud for production use, though it runs against a local browser too. Positioned by third
parties as one of "five browser-control agent stacks that dominate 2026." Not aimed at
white-box debugging; `extract`/`observe` are about *data*, not console/network/perf signal.

### browserbase.com (Browserbase, the cloud)
Managed headless-browser-session cloud (Puppeteer/Playwright/Selenium-compatible), stealth,
session recording/replay, proxy rotation. This is Stagehand's and Skyvern's default production
backend and a common "provider" target for agent-browser and browser-harness. Cloud-hosted —
by construction it cannot see a developer's own `localhost` without a tunnel, so it targets
production/staging QA and scraping, not the "verify my own machine's dev server" job.

### Skyvern-AI/skyvern
AGPL-3.0 (commercial cloud carve-out for anti-bot/CAPTCHA features), ~22.6k stars. Combines
an LLM with computer vision on a Playwright-compatible base so it can operate sites it's
**never seen before** by visually parsing the viewport rather than relying on selectors —
strongest at WRITE-style RPA tasks (form-fill, login, download, apply-to-job). Access via
cloud platform, Python/TypeScript SDKs, no-code workflow builder, MCP, and Zapier/Make/n8n.
64.4% on WebBench. Explicitly production/RPA-positioned (invoice downloads, procurement,
government forms across arbitrary live sites), not a localhost-debugging tool; no
console/network/perf story at all.

## 4. Cloud browser infrastructure (headless-browser-as-a-service)

- **Steel.dev** (`steel-dev/steel-browser`, Apache-2.0, ~7.4k stars, public beta): self-hosted
  or cloud "batteries-included" browser API over Docker + Puppeteer/CDP — Sessions API for
  stateful multi-request browser instances (cookies/localStorage persisted), stateless Quick
  Actions (`/scrape`, `/screenshot`, `/pdf`), proxy chains, custom extension loading, stealth
  fingerprinting. Node/Python/Rust/Go SDKs. Recently added "Steel Skills," a catalog of five
  packaged agent skills, and an "Atlas" feature in its Launch Week v3. Self-hostable, so it
  *can* run next to localhost, but it's designed as infra you script against, not a
  debugging-bundle tool.
- **Hyperbrowser** — YC-backed cloud infra emphasizing anti-bot evasion (stealth fingerprints,
  proxy rotation, CAPTCHA solving) at serverless scale; ships open-source **HyperAgent**
  (extends Playwright with `page.ai`/`page.extract`/`executeTask`) and an MCP server for
  Claude Desktop/Cursor/Windsurf. Same shape as Steel/Browserbase: production automation
  against arbitrary live sites, not local dev-loop debugging.
- **Kernel** (onkernel.com) — $22M-funded, unikernel-based Chromium sandboxes claiming ~150-300ms
  cold starts, with a REST API covering session lifecycle, pools, profiles, proxies, replay,
  extensions, computer-use primitives (mouse/keyboard/clipboard/screenshot batch actions),
  in-browser filesystem/process exec, and Playwright execution. Notable for how *broad* its
  control-plane surface is — closest cloud analogue to a "daemon with named sessions," but
  cloud-hosted, so still can't reach a developer's localhost without a tunnel.
- **browserless.io** — long-running (since Puppeteer's early days) managed headless-Chrome
  service; BrowserQL declarative automation language, Function API for custom Puppeteer/ESM
  code, Persistent Sessions (state retained up to 90 days), screenshots in ~1s / PDFs in ~2s.
  Trusted by "2,000+ teams." General-purpose automation infra, no agent-specific debugging
  bundle.
- **Lightpanda** (`lightpanda-io/browser`) — a from-scratch **Zig** browser engine (not a
  Chromium/WebKit fork): libcurl for HTTP, html5ever for parsing, a custom DOM, and V8 via a
  Zig wrapper for JS — deliberately missing a CSS layout engine, image decoder, GPU compositor,
  font rasterizer, and accessibility tree. Benchmarks ~11x faster and ~9x lower memory than
  headless Chrome for scraping workloads (2.3s vs 25.2s for 100 pages; 24MB vs 207MB peak RAM).
  Speaks CDP (works with Playwright/Puppeteer) and has native MCP support. **Disqualifying for
  Glassbox's job by design**: no layout engine means no real box model/computed styles, and no
  accessibility tree means no a11y snapshot — it optimizes away exactly the signals a UI-
  verification tool needs, in exchange for raw throughput on text/data extraction.

## 5. Extensions that bring an agent into an existing browser

### Claude for Chrome / Claude Code Chrome integration (Anthropic)
Two related but distinct surfaces. **Claude for Chrome** is a standalone extension (beta,
paid plans) letting Claude.ai itself browse, click, and fill forms in your existing Chrome
session — general web-agent use, with an explicit prompt-injection threat model called out in
Anthropic's own materials. **Claude Code's `--chrome` integration** (`code.claude.com/docs/en/chrome`)
is the more relevant one for Glassbox: Claude Code (CLI or VS Code extension) connects to the
same "Claude in Chrome" extension via a native-messaging host, opens **visible** browser tabs
in real time, and shares the developer's logged-in session. Documented capabilities map almost
exactly onto Glassbox's "verification bundle" idea in prose form: "read console errors and DOM
state directly, then fix the code that caused them"; explicit worked example —
*"I just updated the login form validation. Can you open localhost:3000, try submitting the
form with invalid data, and check if the error messages appear correctly?"* — is Anthropic's
own canonical localhost-verification workflow. Also supports session-recording to GIF,
screenshot-to-disk, file upload from the agent's filesystem to a page. Tool surface is exposed
as the `claude-in-chrome` MCP server (`/mcp` → `claude-in-chrome` → View tools). Read-only
calls (read_page, get_page_text, find, console/network reads, screenshot) run without a
permission prompt in plan mode; state-changing calls (click, type, navigate, record) require
approval. **Session/parallelism model is effectively single-session**: one Chrome instance,
one native-messaging pipe per machine; nothing named or isolated per-worktree, and the docs'
own troubleshooting section documents the service-worker-goes-idle failure mode on long
sessions requiring manual `/chrome` reconnect. No breakpoints, no coverage, no computed-style/
cascade tools, no CDP tracing — it's automation-plus-console/network-reads, not a white-box
debugger. **This is the best "human ride-along" story in the entire landscape** (visible
window, pauses for the human on login/CAPTGHA) but it is a product feature of a single-user
desktop app, not an inspectable daemon a coding agent could stand up N of.

### Nanobrowser
Open-source (Apache-2.0) Chrome extension, ~13.5k stars, last release Nov 2025 (cadence has
slowed). Multi-agent design — Navigator, Planner, Validator — with per-agent model assignment
across 8+ LLM providers including local Ollama. Fully local/private ("credentials stay with
you, never shared with any cloud service"), sidebar chat UI. Positioned as a free alternative
to OpenAI's (now-retired) Operator. General web-task automation, not developer-debugging
focused — no console/network/perf tooling surfaced to the user or the model.

## 6. Standalone "agentic browsers" (new browser, not an extension)

- **BrowserOS** (`browseros-ai/BrowserOS`) — open-source (AGPL-3.0) **Chromium fork** that
  runs agents locally rather than shipping them to a vendor cloud; keeps full Chrome-extension
  compatibility; supports 11+ model providers plus local models via Ollama/LM Studio;
  positions explicitly as the privacy-first alternative to Atlas/Comet/Dia. Shipped an early
  "BrowserClaw" agent-driving variant. Standalone browser you'd have to adopt as your daily
  driver — not something a coding agent spins up headlessly per PR.
- **Fellou** — proprietary standalone "agentic browser," >1M users claimed, notable for
  letting the user **inspect and edit the agent's planned workflow before execution** (a
  transparency feature most competitors lack). Consumer task-automation positioning
  (research, report drafting, workflow automation across sites), not a dev tool.
- **Perplexity Comet** — Chromium-based, agent sidebar with persistent per-tab context; went
  from $200/mo Max-only (July 2025) to free on all platforms (Oct 2025); iOS app hit #3 US App
  Store within 48 hours of its March 2026 launch; also licensed into Samsung Internet as a
  default search/agent option. Consumer answer-engine-to-browser expansion; fills forms and
  compares products, no developer/debugging surface.
- **OpenAI ChatGPT Atlas → discontinued** — launched Oct 21, 2025 (macOS-only, Chromium-based,
  persistent sidebar, "Agent Mode," browser memory); OpenAI confirmed its **deprecation date
  as August 9, 2026**, folding its agent capabilities into a new "ChatGPT Work" product plus an
  enhanced ChatGPT desktop app and a dedicated Chrome extension instead of a standalone
  browser. Signal worth weighing: the best-funded standalone-agentic-browser bet in the market
  was unwound within nine months in favor of an *extension-into-existing-browser* model — the
  same shape Anthropic and Google chose from the start.
- **Dia** (The Browser Company, now an Atlassian subsidiary after a $610M acquisition closed
  Oct 21, 2025) — proprietary, macOS-only (Windows signup page live but unshipped as of
  mid-2026), successor to Arc; AI sidebar, "Skills" custom shortcuts, cross-tab "Memory,"
  auto-organized tab groups; $20/mo Pro tier. Consumer productivity browser, not agent-for-
  developers.
- Also named in the category by market surveys but not separately profiled here: **Opera
  Neon** (~$19.90/mo standalone), **Genspark**, **Sigma AI Browser**, **Google Disco**, plus
  in-existing-browser entries **Chrome+Gemini**, **Edge Copilot Mode**, **Brave Leo**.

## 7. Computer-use APIs (screenshot+mouse/keyboard, no DOM access)

- **Anthropic Computer Use API** (beta tool on the Claude API): screenshot-in, mouse/keyboard-
  action-out, portable across any VM/container/sandbox the *caller* controls — general
  desktop automation, not browser-specific, and Anthropic's own guidance is to prefer a
  connector or Claude-for-Chrome when the task is browser-shaped and fall back to raw
  screen control only when nothing else applies.
- **OpenAI computer-use-preview / CUA** — the model behind the retired Operator product,
  now exposed to developers through the OpenAI Agents SDK. Takes screenshots, returns
  click/type/scroll actions. Benchmarked at 38.1% (OSWorld, full computer use), 58.1%
  (WebArena), 87% (WebVoyager). Both APIs are vision-loop primitives a team could build a
  Glassbox-shaped tool on top of, but neither *is* one — no DOM/CDP access, no console/network
  reads, no session concept beyond whatever harness wraps the loop.

## 8. Emerging standard: WebMCP

Not an agent tool but a relevant platform shift: Chrome's WebMCP (W3C Web Machine Learning
Community Group proposal, not yet Standards Track) lets a **site itself** register typed
JS-function/HTML-form "tools" for in-browser agents to call directly, instead of agents
reverse-engineering the DOM through simulated clicks. Public origin trial opened in Chrome 149
(announced May 19, 2026); DevTools ships experimental support to inspect/invoke registered
tools and validate their JSON Schema. If adopted, this could eventually let a localhost dev
server *declare* its own verification hooks — but as of mid-2026 it targets production sites
opting in, not a generic contract a coding agent can rely on for arbitrary localhost apps, and
adoption is early/experimental.

## Gap analysis: capability combinations that exist nowhere

Cross-referencing every entrant above against Glassbox's six hypotheses:

1. **Daemon owning Chromium via CDP** — common (playwright-mcp, chrome-devtools-mcp, Steel,
   Kernel, browser-harness all do this).
2. **Named, parallel, isolated sessions** — this is the sharpest, most consistently confirmed
   gap. playwright-mcp's own README warns single-profile-single-instance; issue #893 is a live
   bug report of exactly the failure mode Glassbox is designed to prevent (parallel Claude Code
   agents fighting over one tab); chrome-devtools-mcp's multi-tab routing is an
   `--experimental` flag, not a first-class session concept; Claude Code's Chrome integration
   is architecturally one native-messaging pipe per machine. Every real workaround in the wild
   is "run N separate MCP server processes with N separate `--user-data-dir`s" — infra a team
   builds around the tool, not a feature the tool provides. **No surveyed tool ships named
   session addressing (`glassbox open --session pr-42`) as a designed primitive.**
3. **MCP *and* CLI dual interface** — rare. agent-browser (Vercel) is the one clean example
   (Rust CLI that can also speak MCP-over-stdio). Almost everything else picks one: MCP-only
   (playwright-mcp, chrome-devtools-mcp, Hyperbrowser's server) or SDK/CLI-only
   (browser-harness, browser-use's Python library, Stagehand's SDK). No tool treats CLI and
   MCP as equally-first-class front ends onto the *same* session/daemon the way Glassbox
   hypothesizes.
4. **One-call verification bundle (console+network+a11y+layout+screenshot together)** — does
   not exist as a single call anywhere surveyed. chrome-devtools-mcp comes closest in
   *breadth* (it has all five signal types) but each is a separate tool invocation the agent
   must sequence and reconcile itself; a11y-mcp/axe-core tools are entirely separate projects
   from the CDP/perf tooling; nobody bundles "did this change break layout, a11y, console, or
   network" into one artifact.
5. **White-box debugging (breakpoints, coverage, cascade introspection)** — thinnest layer in
   the whole landscape. chrome-devtools-mcp has open, recent feature requests/partial support
   for computed styles (#86) and CSS coverage (#731); nothing surveyed exposes JS breakpoints
   as an agent-callable primitive with structured stop/inspect/resume semantics — Chrome
   DevTools' own Sources-panel breakpoint improvements (Chrome 150) are for *human* DevTools
   users, not yet piped through any MCP server's tool schema.
6. **Human ride-along viewing** — Claude Code's Chrome integration is the strongest instance
   (visible window, pauses on login/CAPTCHA for the human), but it's a single-user desktop
   feature tightly coupled to Anthropic's own product, not something a general daemon exposes
   to whichever browser tool a team chooses. Kernel's "live view" and Steel's debug UI are the
   closest cloud analogues, but those are for watching a *remote* session, not riding along
   with a *local* one a coding agent just opened.
7. **All artifacts on disk, uniformly** — closest matches are agent-browser (structured CLI
   output, `--save`-style flags) and Claude Code's Chrome integration (explicit
   screenshot-to-disk / GIF-recording commands), but neither guarantees a consistent
   session-scoped directory of console logs + network HAR + a11y report + layout diff +
   screenshots + trace for every verification run; it's per-tool-call opt-in artifact saving,
   not a session-level contract.

**Net read:** the ecosystem has converged hard on two shapes — (a) broad, single-instance MCP
servers optimized for one agent driving one browser at a time (playwright-mcp,
chrome-devtools-mcp), and (b) cloud browser fleets optimized for many *unrelated* agents
running *unrelated* tasks at production scale (Browserbase, Steel, Hyperbrowser, Kernel,
browserless) — with almost nothing built for the specific middle case Glassbox targets: one
developer, several *concurrent, named, related* Claude Code sessions (e.g., parallel git
worktrees) all verifying the same localhost app without stepping on each other's tabs, and
each verification producing one structured, disk-persisted bundle instead of a hand-assembled
sequence of tool calls. chrome-devtools-mcp is the strongest raw-capability foundation to build
on (it already has the perf/memory/console/network primitives); the gap is session
architecture and bundling, not missing CDP capability.

## Sources

- https://github.com/microsoft/playwright-mcp
- https://github.com/microsoft/playwright-mcp/issues/893
- https://github.com/ChromeDevTools/chrome-devtools-mcp
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/86
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/731
- https://developer.chrome.com/blog/chrome-at-io26
- https://developer.chrome.com/blog/new-in-devtools-150
- https://developer.chrome.com/blog/ai-webmcp-origin-trial
- https://code.claude.com/docs/en/chrome
- https://claude.com/claude-for-chrome
- https://www.usecarly.com/blog/what-is-claude-in-chrome/
- https://github.com/browser-use/browser-use
- https://github.com/browser-use/browser-harness
- https://github.com/browser-use/browsercode
- https://github.com/browserbase/stagehand
- https://www.browserbase.com/stagehand
- https://www.browserbase.com/blog/stagehand-v3
- https://github.com/steel-dev/steel-browser
- https://steel.dev/
- https://www.hyperbrowser.ai/docs/agents/overview
- https://github.com/Skyvern-AI/skyvern
- https://www.skyvern.com/
- https://github.com/nanobrowser/nanobrowser
- https://github.com/browseros-ai/BrowserOS
- https://browseros.com/
- https://www.buildfastwithai.com/ai-tools/fellou
- https://techcrunch.com/sponsor/fellou/the-rise-of-fellou-worlds-first-agentic-ai-browser/
- https://www.switchtools.io/blog/perplexity-comet-ai-agent-browser
- https://cryptobriefing.com/openai-shuts-down-chatgpt-atlas-browser/
- https://ppc.land/openai-kills-atlas-browser-folds-it-into-new-chatgpt-work-agent/
- https://openai.com/index/introducing-operator/
- https://openai.com/index/computer-using-agent/
- https://developers.openai.com/learn/cua
- https://en.wikipedia.org/wiki/Dia_(web_browser)
- https://github.com/vercel-labs/agent-browser
- https://bitbasti.com/blog/moving-toward-code-based-agents-agent-browser-cli-workflows
- https://agent-browser.dev/engines/lightpanda
- https://github.com/lightpanda-io/browser
- https://apidog.com/blog/lightpanda/
- https://www.browserless.io/
- https://github.com/browserless/browserless
- https://www.onkernel.com/docs/introduction
- https://blog.onkernel.com/series-a-announcement/
- https://developers.cloudflare.com/browser-rendering/playwright/playwright-mcp/
- https://www.cloudflare.com/products/browser-rendering/
- https://nohacks.co/blog/agentic-browser-landscape-2026
- https://ppc.land/chrome-149-origin-trial-puts-webmcp-in-developers-hands-at-last/
- https://github.com/priyankark/a11y-mcp
- https://www.unbrowse.ai/blog/best-mcp-server-web-browsing-2026
