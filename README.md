# Glassbox

**An instrumented local browser daemon for agentic UI verification.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-green.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-14%20tools-8A2BE2.svg)](#mcp-setup-claude-code)
[![Status](https://img.shields.io/badge/status-v0.1.0-orange.svg)](docs/BUILD-LEDGER.md)

![Terminal recording: one `glassbox verify` call reports the console, network, layout and accessibility defects on a page, then `style` explains a contrast bug from the cascade and `debug listeners` proves a button is dead](assets/demo.gif)

*Real, unedited terminal output. The page under test is `test/bugzoo/layout.html` — the seeded-bug
site this repo's proofs verify against.*

Your coding agent just edited the checkout page. Now it has to answer, with no human in the
loop: *does the site actually work and look right?* Today it guesses — or it burns fifteen tool
calls stitching together a screenshot, a console dump, and a hopeful `networkidle`.

Glassbox is the instrument that answers the question in one call:

```console
$ glassbox verify -s checkout
verify ISSUES — settled [COLD load] at http://localhost:4321/checkout
  counts: consoleErrors=1 pageerr=0 net(failed=0 http=2 hang=0 mixed=0) a11y=1 layout=3
  [error/console] console.error: Cannot read properties of null (reading 'value') (cart.js:12)
  [warn/layout] Low text contrast: p#total — contrast ratio 1.04:1 (needs 4.5:1)
  [warn/layout] Horizontal overflow: .promo-row overflows viewport by 38px
  [warn/a11y] button.icon-only has no accessible name
  report: C:\Users\you\AppData\Local\glassbox\sessions\checkout\reports\verify-1.json
  shots: C:\Users\you\AppData\Local\glassbox\sessions\checkout\shots\verify-1.webp
  2841ms
```

One command. Console + page errors + network taxonomy + layout pathology + accessibility +
build-error overlay + screenshots, as one structured report — with the source maps already
applied and the artifacts written to disk as **paths**, not inline images.

It is **not** a general web agent, a scraper, or a test runner. It verifies the UI you are
building, on localhost, right now.

---

## Why not just use Playwright MCP or Chrome DevTools MCP?

Use them! They are excellent and Glassbox is not trying to replace them. But they are built to
*drive* and *profile* a browser, and neither is built for the specific loop of "an agent changed
some CSS and needs to know what broke." Verified against their published tool references, July
2026:

| | [chrome-devtools-mcp][cdm] | [playwright-mcp][pwm] | **Glassbox** |
| --- | :---: | :---: | :---: |
| Named parallel **storage-isolated** sessions in one process | pages, not isolated contexts | one process per isolated client | **yes — the default topology** |
| One-call verify bundle (console+net+layout+a11y+overlay+shots) | `lighthouse_audit` is the closest | — | **yes** |
| Breakpoints, paused-frame locals, stepping | — | — | **yes** |
| CSS cascade with computed specificity (`✓won / ✗overridden`) | — | — | **yes** |
| JS + CSS coverage (`count:0` = never ran) | — | — | **yes** |
| Same verbs as a **CLI** *and* an MCP server, one daemon | MCP only | MCP only | **yes** |
| Performance traces, heap snapshots, extensions | **yes** | — | — |
| Cross-browser (Firefox / WebKit) | — | **yes** | — |
| Network mocking / routing, video, tracing | — | **yes** | — |

The last three rows are the honest other half: if you need a flame chart, a heap diff, or WebKit,
those tools do things Glassbox does not and will not.

[cdm]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md
[pwm]: https://github.com/microsoft/playwright-mcp

### The design brief, in five lines

Underneath all of it: the browser's state lives **outside** the agent's conversation. Sessions are
addressable by name, journals are readable cold, and a compacted or forked agent loses nothing.
Full reasoning in `docs/00-first-principles.md` and `docs/01-architecture.md` §0.

1. **Named parallel isolated sessions** as the default topology. Ten subagents, ten sessions, one
   browser process, zero storage bleed.
2. **One-call verification bundles.** Not fifteen fragile steps.
3. **A white-box debug plane.** Breakpoints, paused-frame inspection, coverage, and a cascade
   "why does this look wrong" tool with real specificity.
4. **CLI + MCP duality on one daemon.** Same verbs, same endpoints, two faces.
5. **An artifact directory per session** on disk — screenshots and reports come back as *paths*,
   because inline images cost 10–20× the tokens in Claude Code.

---

## Install

```bash
git clone https://github.com/adihebbalae/glassbox && cd glassbox
npm install                      # one runtime dep: playwright
npx playwright install chromium  # the browser binary itself
npm link                         # optional: puts `glassbox` (and `sibox`) on your PATH
```

Node 22+ (the suite runs on 24). Without `npm link`, every example below works as
`node src/cli.mjs …`.

> **`sibox` is the same command, three letters shorter.** The npm package is `sibox` and both names
> are installed, so `sibox verify -s checkout` and `glassbox verify -s checkout` are the same call.
> It is not an arbitrary abbreviation: glass is silicon dioxide, so **Si**-box is the same metaphor
> at the chemical level — and it is also what the tool does, since the agent gets to **see** into the
> browser rather than guess at it. Every example in this README uses `glassbox`; type whichever you
> prefer.

## 60-second quickstart

```bash
# 1. open a session (auto-starts the daemon on first use — there is no "start" step)
glassbox session open checkout

# 2. point it at your dev server (waits for real quiescence, not networkidle)
glassbox goto http://localhost:4321/checkout -s checkout

# 3. THE call
glassbox verify -s checkout

# 4. let a human watch (live screencast + click/key takeover)
glassbox watch checkout

# 5. done — end YOUR sessions (the daemon is shared; this leaves everyone else's alone)
glassbox kill-all --mine
```

Iterating against a dev server? Run it *through* Glassbox — one command spawns it, finds its ready
URL in its own output, attaches a session, and verifies:

```bash
glassbox dev --cmd "npm run dev" --cwd . -s dev
# streams: rebuilds are journaled, build-error overlays print as BUILD ERROR [vite] …
# q + Enter to stop
```

## MCP setup (Claude Code)

Add to your project's `.mcp.json` (or `~/.claude.json` under `mcpServers`):

```json
{
  "mcpServers": {
    "glassbox": {
      "command": "node",
      "args": ["/path/to/glassbox/src/cli.mjs", "mcp"]
    }
  }
}
```

The shim is stateless and auto-starts the shared daemon on first use, so one shim per Claude
session (or subagent) is cheap and safe — the browser state lives in the daemon, not in the shim.

Fourteen tools: `gb_session`, `gb_goto`, `gb_act`, `gb_observe`, `gb_read`, `gb_verify`,
`gb_screenshot`, `gb_style`, `gb_eval`, `gb_wait`, `gb_debug`, `gb_coverage`, `gb_dialog`,
`gb_watch`.

**`skill/SKILL.md` is the agent-facing manual** — session-per-agent pattern, verify-first loop,
debug recipes, PAUSED-lane rules. Copy it into `.claude/skills/` (or point your agent at it) so
the model learns the workflow, not just the schemas.

---

## Status, and what is not proven

v0.1.0, first complete build. Being honest about the edges, because a verification tool that
overstates itself is worse than useless:

- **Windows 11 / Node 24** — developed here. Full suite green: **13 modules, 296 checks**.
- **Linux, in an agent sandbox** — proven in M13. The same codebase runs in an ephemeral
  container behind a platform seam, full suite green. The process reaper is two implementations
  behind one dispatch (`taskkill`/WMI on win32, `/proc` on POSIX).
- **macOS** — *known broken, and this README used to say otherwise.* It previously claimed macOS
  "very likely works, since it takes the same POSIX path as Linux." A static audit
  ([`docs/macos-audit.md`](docs/macos-audit.md)) showed that was false: the POSIX path is a `/proc`
  reader, and macOS has no `/proc`. The process reaper is inert there — `verifyGlassboxPid()`
  returns `false` unconditionally, so `kill-all` cannot stop a wedged daemon and then deletes its
  record anyway, orphaning it. `--headed` silently downgrades to headless. Worse for a tool like
  this: roughly twenty "no strays" assertions in the suite would pass **vacuously**, so a Mac user
  sees a mostly-green run whose green means nothing.

  The platform seam is really win32/linux/darwin, not win32/POSIX. Tracked in issue #1; fixes are
  written but unverifiable without a Mac. If you have one, that's the most useful contribution
  available right now.
- **The suite is not isolated from your live daemon.** It runs against your real state root and
  opens each milestone with `kill-all`, so a Glassbox daemon left idle more than five minutes on the
  same machine will be shut down by a test precondition. Three source comments claimed the suite
  set `GLASSBOX_HOME` to prevent exactly this. None of the thirteen tests do. What actually protects
  a *busy* daemon is the session-ownership guard, which is a different mechanism arrived at for a
  different reason — the right protection by luck, not design. Issue #2; §11.7 of
  [`docs/01-architecture.md`](docs/01-architecture.md).
- **No CI yet.** The suite drives a real Chromium for ~6 minutes; wiring that into Actions is
  the next infrastructure job.

Also deliberately out of scope for v1: cloud/remote browsers, stealth or CAPTCHA anything,
cross-engine (BiDi) abstraction, performance-trace UI, scraping ergonomics, and React/Vue
component-tree inspection (version-fragile).

---

## CLI verbs

`CLI verbs = MCP tools = the same daemon endpoints.` Add `--json` to any command for machine
output; `-s <session>` (or `GLASSBOX_SESSION`) names the session.

**Sessions & lifecycle**

| Command | What it does |
| --- | --- |
| `session open <name> [--headed] [--viewport WxH] [--color light\|dark] [--theme-attr ATTR] [--theme-class CLASS] [--ignore-404 /path] [--base-url URL]` | Create an isolated session (auto-starts the daemon); prints its watch URL |
| `session ls` / `session rm <name>` | List / destroy |
| `session resize <name> WxH` | Resize a live session (mobile checks without re-opening and re-seeding) |
| `daemon start\|stop\|status` | Explicit daemon control (rarely needed) |
| `artifacts -s <session>` | List the on-disk shots / reports / net logs / journal |
| `kill-all --mine` | End the sessions **you** opened; leave the daemon (and other agents' work) alone. The normal cleanup |
| `kill-all` | Whole daemon. **Refuses** while another client's sessions are in use, naming them |
| `kill-all --force` | Machine-wide clean slate: every session, every Glassbox Chromium/daemon, orphaned dev servers — including other agents' live work |
| `--client <id>` / `GLASSBOX_CLIENT` | Who you are. Sessions are owned by whoever opened them; the MCP shim sets `mcp-<pid>` automatically |
| `mcp` | Run the stdio MCP server (this is what `.mcp.json` points at) |

**Navigate & act** — target by `<css>` positionally, or `--ref eN` / `--testid` / `--role`+`--name` / `--text`

| Command | What it does |
| --- | --- |
| `goto <url>` | Navigate + settle, returns a delta |
| `click\|dblclick\|hover <css> [--force]` | Act with Playwright actionability **plus a hit-point check**, then settle. A covered target fails `ACT_OCCLUDED` naming the coverer; `--force` dispatches anyway and stamps `forced:true` |
| `type <text> --selector CSS [--submit]` · `press <key>` | Fill / key input |
| `scroll [--to top\|bottom\|CSS\|eN] [--by PX]` | Scroll |
| `drag --from CSS --to CSS` · `upload --files a,b` · `select --values x,y` | The rest of the input verbs |
| `dialog accept\|dismiss [--text T]` | Answer a native dialog (they are stashed, never left hanging) |
| `eval "<expr>" [--await]` | Evaluate in the page; returns value + console it emitted |
| `wait [--selector CSS \| --text T \| --url U \| --hydration \| --sleep MS]` | Targeted wait; never throws, returns `matched:false`. `--url /path` matches the pathname at a segment boundary; `--sleep` always succeeds after the duration |

**Observe & verify**

| Command | What it does |
| --- | --- |
| `verify [--scope CSS] [--themes] [--viewports] [--cold] [--ignore-404 /path] [--no-axe] [--no-shots] [--no-theme-reload]` | The one-call bundle. `--themes` reloads per leg (boot-time theme readers) and drives `--theme-attr`/`--theme-class`; identical light/dark shots are themselves a finding. Every report labels the load state it measured (**cold vs warm**); `--cold` clears the cache and re-navigates first |
| `read console\|network\|errors\|overlay [--since N]` | One channel at a time, cursored, source-map-remapped |
| `observe [--selector CSS] [--limit N]` | Distilled DOM+AX tree with numbered refs (~1.4k tokens, not 95k) |
| `screenshot [--full] [--selector CSS] [--theme light\|dark] [--no-force-paint]` | Writes a webp, prints the **path**. `--full` **and** `--selector` force `content-visibility:auto` sections to paint first (else they come back blank); `--selector` is framed in page coordinates, so it is correct at any scroll position, and warns when a clip is featureless anyway |
| `settle` | Block until the page quiesces |

**Debug (white-box)**

| Command | What it does |
| --- | --- |
| `debug break --file app.js --line N [--condition EXPR]` | Breakpoint, snapped to the first valid location at/after the line |
| `debug state \| inspect [--frame N] \| eval "<expr>"` | Frames / locals-with-values / compute on the frozen frame |
| `debug step [over\|into\|out] \| resume \| pause \| screenshot` | Stepping and a shot of the frozen page |
| `debug listeners <css>` | The dead-button question, answered honestly: echoes the node it inspected, warns when the selector matched several, and checks ancestors for React-style delegation before calling anything dead |
| `debug coverage-start` … `coverage-stop` | JS + CSS coverage; `count:0` = "this never ran" |
| `style <css>` | Why it looks wrong: computed styles, contrast, cascade with real specificity, ✓won / ✗overridden |

**Watch & dev loop**

| Command | What it does |
| --- | --- |
| `watch [session]` | Live screencast + takeover page (no arg = session grid) |
| `dev [--cmd "npm run dev"] [--cwd DIR] [--timeout SECONDS] [--no-attach] [--auto-verify]` | Spawn a dev server, discover its URL, attach, verify, then stream rebuilds |

---

## Architecture

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

- **Playwright** owns launch/cleanup, actionability auto-wait, and input dispatch; **raw CDP**
  (`context.newCDPSession`) owns everything Playwright doesn't expose: `Debugger`, coverage,
  `CSS.getMatchedStylesForNode`, `Accessibility`, `Page.startScreencast`,
  `DOMDebugger.getEventListeners`.
- **A session is a BrowserContext** in one shared browser (~250ms to create, storage-isolated).
  Commands serialize *within* a session and run fully parallel *across* sessions.
- **Discovery** is an atomically written `%LOCALAPPDATA%\glassbox\daemon.json` (`port`, 32-byte
  `token`, `pid`, `version`), loopback-only — no firewall prompts, no ambient auth.
- **Settling** is composite (load → network low-water → debounced MutationObserver → chained rAF →
  `astro-island[ssr]` cleared), hard-capped, and reports `settled:false` with a reason instead of
  hanging. `networkidle` is not used anywhere.

Full decisions with evidence: `docs/01-architecture.md`. Milestones and proofs:
`docs/02-build-plan.md`.

## Artifacts on disk

```
%LOCALAPPDATA%\glassbox\
  daemon.json                     # discovery: port, token, pid, version
  chrome-data\{headless,headed}\  # --user-data-dir (also the orphan-sweep marker)
  dev\<pid>.json                  # live `glassbox dev` records (kill-all reaps orphans)
  sessions\<name>\
    journal.jsonl                 # every create/command/dialog/debug/rebuild event, in order
    reports\verify-N.json         # the full report (findings uncapped) + axe-N.json
    net\verify-N.json             # the full network log + taxonomy
    shots\*.webp | *.png          # screenshots — returned as paths, never inline
```

The journal is the cold-attach story: a fresh agent with no context can read
`sessions/<name>/journal.jsonl` and know exactly what happened.

---

## Sandbox

The same instrument, in an ephemeral Linux container where an agent writes the code and checks it.
`glassbox doctor` is the first thing to run anywhere new — browser, display mode, egress, and
state root are all probed, none guessed. `docs/01-architecture.md` §11 is the decision record;
the short version:

| | local | sandbox |
| --- | --- | --- |
| browser | `channel:'chromium'` | resolved by path, `--disable-dev-shm-usage` |
| default mode | headless | **headed under Xvfb** |
| egress | open | jailed — measured at daemon start, not assumed |
| failed external request | a defect | `sandboxBlocked`: one info line, excluded from `ok` |
| fonts | system | `substituted` (on evidence) or `har-replayed` |
| human channel | `watch` — live screencast | `export` — one self-contained `.html` |
| cleanup | `kill-all --mine` protects other agents | single-tenant; `--force` is normal |

`npx playwright install` needs network an agent sandbox's allowlist usually does not permit, and
playwright pins a browser revision per release — so a container that ships a *different* revision
fails channel resolution. Glassbox resolves a Chromium by path instead, or finds one under
`PLAYWRIGHT_BROWSERS_PATH`.

Headed is the sandbox default for the UA string and for GPU-dependent rendering. It used to be the
default for a much bigger reason — layout accuracy — and that reason is now gone, which is worth
reading in full because it is the most instructive mistake in this repo.

> **Correction, 2026-07-28.** This section used to claim that headless Chromium reports a 0px
> *overlay* scrollbar, and that headless therefore could not see horizontal overflow or right-edge
> clipping at all. The observation was real. The cause was wrong.
>
> Playwright appends `--hide-scrollbars` to every headless launch, unconditionally, so that visual
> comparisons stay deterministic across platforms with different scrollbar widths — a sound default
> for screenshot testing and a destructive one for layout verification. Measured, 800×600, a page
> with a `100vw` child:
>
> | launch config | `innerWidth − clientWidth` | overflow detected |
> | --- | --- | --- |
> | headless, Playwright defaults | **0px** | ❌ |
> | headless + `ignoreDefaultArgs: ['--hide-scrollbars']` | **15px** | ✅ |
> | headed | **15px** | ✅ |
>
> Headless was never blind. This launcher was, by inheriting a flag it never chose — and so is
> anything else built on Playwright or Puppeteer headless. **Fixed:** `launchOptions()` now takes
> the flag back, and `GLASSBOX_HIDE_SCROLLBARS=1` restores the old behaviour for anyone diffing
> screenshots across machines, where Playwright's reasoning is legitimate.
>
> Two things about how this was found are more useful than the finding:
>
> - **The check that should have caught it passed.** The only seeded overflow fixture was a 3000px
>   element, which overflows by ~2200px and is visible with or without a gutter. The `100vw` case —
>   which overflows by *exactly* the scrollbar width, and is the only case the flag erases — was
>   never seeded. So 293 checks went green on a configuration that could not see the class.
>   `test/bugzoo/overflow-vw.html` now seeds it, and the check fails against every commit before
>   this one.
> - **It is the exact failure this tool exists to catch** — an assertion that passed because it had
>   nothing left to inspect, which is defect class W3 in `docs/defects-*.md`. Committed on the
>   headline finding, in the verification tool, for months. That is what the line below means in
>   practice: *a finding without its conditions is a claim the instrument cannot support.*

Every verify carries a `conditions` block and every finding a `portability` tag — `portable`
(computed from CSS values, the cascade, the DOM, HTTP status), `font-dependent` (measured off
rendered text, with a substitute typeface), or `sandbox-artifact`. A finding without its conditions
is a claim the instrument cannot support.

**The HAR bridge** is what connects the two halves. Record where the network works, replay where it
does not — one file carries the API responses and the font binaries:

```bash
# networked machine
glassbox session open rec --record-har run.har
glassbox goto http://localhost:5173/ -s rec
glassbox wait -s rec --sleep 1500
glassbox session close rec          # playwright writes the HAR on CLOSE

# sandbox
glassbox session open s --har run.har
glassbox verify -s s                # conditions: fonts: har-replayed
glassbox export -s s --out report.html
```

M13 proves the round trip, including the part that matters most: **the HAR run sees a low-contrast
defect the jailed run could not see at all**, because the stylesheet carrying it never loaded. The
bridge restores findings; it does not just remove noise.

---

## Troubleshooting

**I'm done — how do I clean up?**
```bash
glassbox kill-all --mine   # ends YOUR sessions; other agents keep working
```
The daemon is **machine-wide and shared**, so sessions are owned by whoever opened them (identify
yourself with `--client <id>` or `GLASSBOX_CLIENT`; the MCP shim does it automatically). `--mine`
stops the daemon only if nothing is left in it. `session ls` shows every session's owner.

**Everything is wedged / I want a clean slate.**
```bash
glassbox kill-all          # whole daemon — REFUSES while another client's sessions are live
glassbox kill-all --force  # machine-wide: every session, chromium, daemon, orphaned dev server
```
Bare `kill-all` names who else is in there and stops, because taking the daemon down ends *their*
sessions too — the failure this guard exists for cost a live verification run 15 minutes of work.
`--force` is the real clean slate and its blast radius is the point: it also reaps daemons the
discovery file does not name (`+1 stray`), which is how an orphaned daemon keeps a browser alive
that the next run cannot account for. Everything is PID-reuse-checked, so it can never take down an
unrelated process — but it CAN take down another agent's.

**`DAEMON_UNREACHABLE` or a stale `daemon.json`.** The daemon is auto-started on demand; a stale
discovery file (dead pid, reused port) is detected by a ping+probe handshake and overwritten. If it
persists: `glassbox kill-all --force`, then `glassbox daemon status`.

**My sessions vanished and everything returns `NO_SESSION`.** Read the `daemon:` line in the error —
a pid different from the one your `session open` banner printed means the daemon restarted (crash,
`daemon stop`, or someone's `kill-all --force`) and took every session with it. Nothing is
recoverable; re-open and re-navigate. `glassbox daemon status` shows the current pid and uptime.

**Everything returns `PAUSED`.** That is not a failure — a breakpoint is holding that session.
While paused, `debug state|inspect|eval|step|resume|pause|screenshot` work in a parallel lane and
every *other* verb refuses fast with a structured error instead of deadlocking behind the parked
action. `glassbox debug resume -s <session>` releases it. Sibling sessions are unaffected — that
isolation is proven end-to-end in `test/m8.mjs`.

**A structured error is a next call, not a dead end.** `STALE_REF` (re-observe), `NO_SESSION`
(lists valid names), `NO_TARGET` (with the blocking element when Playwright knows it), `ACT_TIMEOUT`
(with the failed actionability check), `ACT_OCCLUDED` (with the element covering your target — that
one is usually a real bug in the page; `--force` is the opt-out and is recorded), `DEV_NO_URL` (with
the last 20 lines of the dev server's output). Read the `correction_hint` and retry.

**`ACT_OCCLUDED` on something that looks fine.** The check runs at the CURRENT scroll position with
the same rule `verify` uses, so the two can never contradict each other: if a fixed legend/overlay
sits on the target's centre right now, a user can't click it right now. Scroll it clear, close the
overlay, or `--force`.

**`verify` came back clean and I don't believe it.** Check `navigation.kind` in the report. A *warm*
load (a second visit to the same URL in that session) cannot see first-load findings: CLS is a
first-paint race a warm load wins, and a negatively-cached 404 is never re-requested. Re-run with
`--cold` (clears the HTTP cache and re-navigates) or in a fresh session. Sub-resources are always
re-fetched — every tab runs with `Network.setCacheDisabled(true)` — but Chrome's browser-process
favicon cache is outside CDP's reach, which is why `/favicon.ico` 404s only ever show up once.

**`verify` says `settled:false`.** The cap (8s, `GLASSBOX_SETTLE_CAP_MS`) elapsed with a phase still
busy; the report names it (`why:['network']` = a request never finished, `['astro']` = an island
never hydrated). The result is still complete — it just wasn't quiet.

**Env knobs.** `GLASSBOX_SESSION` (default session), `GLASSBOX_SETTLE_CAP_MS`, `GLASSBOX_HANG_MS`
(when an in-flight request is called hanging), `GLASSBOX_IDLE_TTL_MS` (idle-session GC).

---

## Tests

```bash
npm test              # 13 modules, 296 checks, against a real browser (~6 min)
npm run test:m8       # the system-level pass: parallel stress, seed sweep, artifact contract
npm run test:m9       # defect round 1 regressions (each check fails on the pre-fix build)
npm run test:m10      # defect round 2 (deferred content, cold/warm loads, 404 allowlist)
npm run test:m11      # defect round 3 (collapsed <details>, clipped-capture framing)
npm run test:m12      # defect round 4 (session ownership, scoped destroy verbs, --mine blast radius)
npm run test:m13      # the platform seam + sandbox backend + HAR bridge

# OPTIONAL, not in npm test — point it at any project with a `dev` script:
npm run test:live -- --cwd ../my-astro-site
```

Each proof drives the real CLI/daemon against a real Chromium, and every one ends by asserting
`kill-all` leaves zero orphan processes.

`test/bugzoo/` is the seeded-bug site the proofs verify against — 18 deliberate bug classes plus a
clean page as the false-positive check, plus the pages seeded from four rounds of **field defects**
found by dogfooding Glassbox against real sites: an occluded-but-clickable control, a boot-time
theme, a Tailwind class theme, a modal backdrop, an invisible drawer, delegated listeners, deferred
`content-visibility` sections, a request-counting cache page, a collapsed `<details>` accordion, and
a UA-pseudo hide no computed style can explain.

Those four rounds are written up in `docs/defects-*.md` — every defect the tool got *wrong* in the
field, its root cause, and the regression test that now pins the fix. That log is the most useful
thing in this repo if you are evaluating whether to trust it.

A fifth pass, the pre-publish audit, is in §11.7–§11.8 of [`docs/01-architecture.md`](docs/01-architecture.md)
rather than a defects file, because it was read out of the source rather than found in the field. The
one that mattered: `kill-all --mine` reached the machine-wide chromium sweep whenever the daemon's
discovery file was missing, so the scoped destroy verb went machine-wide in exactly the case where it
could not establish that anything belonged to the caller. Measured 8 → 0 on another client's browser;
now 8 → 8. Pinned by m12 `b3`.

### It diagnosed itself, unprompted, while being filmed

The demo GIF above is a single unedited take, and it is the second take. During the first,
unrelated Glassbox activity elsewhere on the machine swept the daemon out from under the recording.
Every subsequent call would have failed. Instead of a bare `NO_SESSION`, the run printed:

```console
daemon: pid 37380, up since 10:57:14 — a different pid than your session banner means it restarted
```

Nobody asked it to explain itself. That line is the diagnostic in "My sessions vanished" above,
firing in the wild against its own author, and it named the exact cause — *a different pid* — rather
than reporting a missing session and leaving the reader to theorise. **Deterministic, not
inferred:** it is a pid comparison against the number the session banner printed, so it cannot be
confidently wrong the way a model's guess about what went wrong can be.

The same incident exposed a real bug, and it belongs in the same paragraph as the win. The swept
daemon (pid 1264) **survived as an orphan** holding no discovery file — so `daemon status` could not
see it, `kill-all --mine` could not reap it, and **nothing warned that it was still running.** Only
`kill-all --force` clears that state, and you have to already suspect it to type that. It is the
same family as D12 in the defect log: an ownership model that is correct about what it can see and
silent about what it cannot. Filed, not fixed.

---

## Contributing

Issues and PRs welcome. The most valuable contributions right now, in order:

1. **Run `npm test` on macOS** and report what happens. See "Status" above.
2. **New bug-zoo pages** — a real UI defect Glassbox misses, as a minimal HTML repro, is worth
   more than a feature.
3. **CI** — wiring the suite into GitHub Actions with a cached Chromium.

`docs/00-first-principles.md` explains why the tool is shaped the way it is; read it before
proposing an architectural change.

## License

MIT — see [LICENSE](LICENSE). Third-party components (vendored axe-core, MPL-2.0; Playwright,
Apache-2.0) are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
