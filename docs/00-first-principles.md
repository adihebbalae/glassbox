# Glassbox — first principles

*Working name: **Glassbox** — a browser whose defining property is that nothing inside it is
opaque to the agent driving it. 2026-07-23, pre-research draft. Everything here is deduction;
the research pass (docs/research/) either confirms or overturns each claim.*

---

## 1. The job to be done

> An agentic code writer (Claude) edits web code, and must then answer — quickly, truthfully,
> and without a human in the loop — **"does the site actually work and look right?"**

That is the entire job. Not browsing, not scraping, not consumer automation. Every design
decision below is derived from this sentence plus the nature of the user — because the user
of this browser is not a human, and that changes everything.

## 2. The user is an LLM agent. What follows from that?

An agent differs from a human browser-user in five load-bearing ways:

**U1. It perceives in tokens, not in continuous vision.** Every observation is a discrete
tool call with a token cost. A human glances at a page 100 times a minute for free; an agent
pays for every glance. → Observations must be *dense*: one call should return everything
relevant, structured, and small.

**U2. It reasons over causes, not over pixels.** A human sees a white button on a white
background and *just knows*. An agent given only a screenshot must guess. An agent told
"`.cta` computes to `color:#fff` on `background:#fff`, inherited from `.hero` at
`styles.css:214`" fixes it in one edit. → The browser must answer **why**, not just **what**.
This is the single biggest gap in every existing tool.

**U3. Its memory is mortal.** Conversations compact, fork, and die; subagents spawn with
zero context. Any state that lives only inside the conversation is state that will be lost.
→ All browser state must live *outside* the agent: in a daemon (sessions addressable by
name) and on disk (journals, screenshots, logs — readable cold by any future agent).

**U4. It is legion.** One Claude session spawns ten subagents; each may need eyes on the
page. The current harness serializes them through one browser. → Sessions must be named,
isolated, concurrent, and cheap. Parallelism is a hard requirement, not a nice-to-have.

**U5. It is bad at busywork and good at judgment.** Every retry loop, every "screenshot →
did it work? → screenshot again," every arbitrary `sleep(2)` is the agent doing scheduler
work an LLM is terrible at. This is what "babysitting" actually is. → Timing, waiting,
settling, and retrying are the *tool's* job. Actions return only when the world has settled,
and they return *what changed*.

## 3. What the job requires, deduced

**R1 — Rendering truth.** The verdict must come from a real engine: real layout, real CSS,
real JS, real fonts, real compositing. Writing a rendering engine is a 10M-LOC,
decade-scale project (Servo and Ladybird are proofs of cost, not options). So "build a
browser" rationally means: **own everything around an existing engine** (Chromium via CDP)
— the shell, the session model, the instrumentation, the interface — and treat rendering
itself as a commodity. We build the observatory, not the star.

**R2 — Observation in the agent's native modality.** Screenshots (for vision), the
accessibility tree / DOM (for structure), the console (for errors), the network log (for
data flow), computed styles + cascade (for *why it looks wrong*). Delivered structured,
deduplicated, and token-budgeted.

**R3 — Actions that settle.** Navigate, click, type, hover, scroll, drag, upload, key
chords — each auto-waits for actionability, executes, waits for quiescence, and reports the
delta (URL changed, console emitted X, DOM region Y mutated). No fire-and-forget.

**R4 — Verification as a primitive, not a choreography.** "Check this page" today is ~15
fragile steps (navigate, wait, screenshot, read, scroll, screenshot, check console…). It
should be **one call** that returns a structured report: console errors, page errors,
failed requests, a11y violations, layout pathologies (overflow, zero-size targets,
white-on-white text), screenshots in both themes and key viewports. Push the checklist into
the tool; the agent spends its tokens on judgment.

**R5 — Sessions as the unit of everything.** A session = one isolated browser context +
one artifact directory + one journal. Created by name in milliseconds, owned by whichever
agent created it, inspectable by any agent, garbage-collected on idle. N sessions run
concurrently in one daemon.

**R6 — White/grey-box depth on demand.** Breakpoints, pause, step, inspect scopes
(CDP `Debugger`), source-mapped stack traces, JS/CSS coverage, DOM mutation and event
timelines, framework internals (React/Vue component trees). Most calls won't need this;
when the agent is genuinely stuck, the floor must open all the way down.

**R7 — Human ride-along.** At 1 a.m. the human sometimes wants to *watch* — live view of
any session, real DevTools attached to the same target, take over / hand back. Debugging is
occasionally pair work; the browser must have a window for the second pair of eyes.

**R8 — Native to Claude Code.** MCP tools for the agentic loop, a CLI for scripts and
humans, files on disk for everything bulky. Tool responses stay small and reference
artifacts by path. Errors are structured and actionable ("element not visible because
covered by `#cookie-banner`; try `dismiss` or `force`") so the agent self-corrects instead
of flailing.

## 4. What we have, measured against R1–R8

| What exists | What it gets right | Where it fails the job |
|---|---|---|
| **browser-harness** (ours) | Compositor-level coordinate clicks through iframes/shadow DOM; raw CDP escape hatch; daemon auto-start | One session, one thread (fails U4/R5); drives the *user's* Chrome, so no isolation and it clobbers real browsing (fails R5); verification = screenshot choreography (fails R4, causes the babysitting); no why-answers (fails U2/R2); no debugging surface (fails R6); its own design rules forbid the session-manager layer this job needs |
| **Playwright / Puppeteer** | Auto-waiting actionability model (R3, solved brilliantly); bundled browsers; contexts | Library-shaped: state lives inside a script process the agent doesn't own (fails U3); built for scripted regression suites, not conversational exploration; parallelism belongs to a test runner, not to named sessions |
| **Playwright MCP / chrome-devtools-mcp** | Validate MCP as the interface; snapshot/ref interaction model; real traction | Typically one browser per server (U4); no verification bundles (R4); no cascade/why introspection (U2); thin-to-no debugger surface (R6); no ride-along (R7) |
| **Claude in Chrome** | Real Claude-browser integration exists | Consumer browsing in the user's browser — wrong job entirely; not parallel, not scriptable, not a dev instrument |
| **Cloud browsers** (Browserbase, Steel, remote browser-use) | Parallel isolated sessions — proof R5 is achievable | Wrong locality: the thing under test is `localhost:4321` with hot reload; remote adds latency, auth walls, and cost for zero benefit here |
| **.shot / screenshot tools** | Cheap visual capture | Observation only; no action, no causes, no sessions |

**The gap, stated once:** every existing tool either drives a browser it doesn't own
(harness, extensions), owns a browser but hides it inside a test-script process
(Playwright), or exposes it to agents without instrumentation depth (MCP servers). Nothing
is a **local, daemon-shaped, session-parallel, instrumented-to-the-floor browser whose only
job is letting a coding agent verify UI**. That intersection is empty. Glassbox fills it.

## 5. The shape this implies (hypothesis for research to attack)

- A **daemon** (`glassboxd`) owning one or more Chromium instances, exposing named,
  isolated, concurrent **sessions** (browser contexts) over a local control plane.
- **Two faces**: an MCP server (agent-native) and a CLI (human/script-native), both thin
  clients of the daemon — so ten Claude threads and a human can share one daemon safely.
- **Artifacts on disk**: per-session journal (JSONL of every action + delta), screenshots,
  network logs, traces — the cold-attach story for mortal agent memory.
- **A verification engine** inside the daemon: the R4 one-call bundle (console + network +
  a11y + layout pathology + multi-theme/viewport captures).
- **A debug plane**: CDP Debugger/coverage/tracing surfaced as tools; DevTools-frontend
  attach + live screencast for the human ride-along.
- **Engine strategy**: Playwright-managed Chromium as lifecycle layer with raw CDP alongside,
  *or* raw CDP over a self-managed Chromium, *or* an Electron shell if the ride-along UI
  earns its weight. **← genuinely open; research decides.**

## 6. Open questions the research pass must answer

1. Electron shell vs. headless Chromium + separate viewer — does Electron buy anything CDP
   screencast doesn't, and what does its lagging Chromium cost?
2. How exactly do playwright-mcp and chrome-devtools-mcp shape their tools (snapshot refs,
   tab model, concurrency), and what do their users complain about? Don't rebuild their
   mistakes; don't rediscover their solutions.
3. Can an MCP tool usefully interact with a *paused* (breakpointed) page — what does the
   protocol allow while execution is frozen?
4. AXTree vs. DOM snapshot vs. set-of-marks screenshots: what does the agent-perception
   literature actually conclude?
5. MCP concurrency in Claude Code: can multiple sessions/subagents share one server
   process, and how should sessions be scoped to callers?
6. What does Vite/Astro HMR integration look like — can the browser *know* a rebuild
   happened and re-verify unprompted?
7. Windows-specific: process lifecycle (no zombie Chromiums), port management, sandbox flags.
