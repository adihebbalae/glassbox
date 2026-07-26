# Glassbox

**An instrumented local browser daemon for agentic UI verification.** A coding agent edits web
code and then has to answer, without a human in the loop: *does the site actually work and look
right?* Glassbox is the instrument that answers it — a real Chromium, owned by a daemon, exposed as
named parallel sessions with a one-call verification bundle and a white-box debugger, through both
an MCP tool surface and a CLI.

It is **not** a general web agent, a scraper, or a test runner. It verifies the UI you are building,
on localhost, right now.

Status: **v0.1.0**, first complete build. Windows-first (developed and proven on Windows 11 / Node
24); the code is plain ESM with no win32-only APIs outside the process reaper, but only Windows is
tested.

---

## Why this exists

Every existing tool either drives a browser it doesn't own (extensions, harnesses), owns one but
hides it inside a test-script process (Playwright), or exposes it to agents without instrumentation
depth (the MCP servers). Five gaps, each documented and unfilled elsewhere — this is the whole
design brief (`docs/00-first-principles.md`, `docs/01-architecture.md` §0):

1. **Named parallel isolated sessions** as the default topology. Ten subagents, ten sessions, one
   browser process, zero storage bleed.
2. **One-call verification bundles.** `verify` = console + network taxonomy + layout pathology +
   a11y + build-error overlay + screenshots, as one structured report. Not fifteen fragile steps.
3. **A white-box debug plane.** Breakpoints, paused-frame inspection, coverage, and a cascade
   "why does this look wrong" tool with computed specificity.
4. **CLI + MCP duality on one daemon.** Same verbs, same endpoints, two faces.
5. **An artifact directory per session** on disk. Screenshots and reports are returned as *paths* —
   inline images cost 10–20× the tokens in Claude Code.

Underneath all five: the browser's state lives **outside** the agent's conversation. Sessions are
addressable by name, journals are readable cold, and a compacted or forked agent loses nothing.

---

## Install

```bash
git clone <this repo> && cd glassbox
npm install                      # one runtime dep: playwright
npx playwright install chromium  # the browser binary itself
```

Node 24 (Node 22+ should work; 24 is what the suite runs on). Optional: `npm link` to put
`glassbox` on your PATH — every example below otherwise works as `node src/cli.mjs …`.

---

## 60-second quickstart

```bash
# 1. open a session (auto-starts the daemon on first use — there is no "start" step)
glassbox session open checkout

# 2. point it at your dev server (waits for real quiescence, not networkidle)
glassbox goto http://localhost:4321/checkout -s checkout

# 3. THE call: one verify, everything at once
glassbox verify -s checkout
#   verify ISSUES — settled at http://localhost:4321/checkout
#     counts: console=1 pageerr=0 net(failed=0 http=2 hang=0 mixed=0) a11y=1 layout=3
#     [error/console] console.error: Cannot read properties of null (reading 'value') (cart.js:12)
#     [warn/layout]  Low text contrast: p#total — contrast ratio 1.04:1 …
#     report: C:\Users\you\AppData\Local\glassbox\sessions\checkout\reports\verify-1.json

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

---

## CLI verbs

`CLI verbs = MCP tools = the same daemon endpoints.` Add `--json` to any command for machine output;
`-s <session>` (or `GLASSBOX_SESSION`) names the session.

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

## MCP setup (Claude Code)

Add to your project's `.mcp.json` (or `~/.claude.json` under `mcpServers`):

```json
{
  "mcpServers": {
    "glassbox": {
      "command": "node",
      "args": ["C:/path/to/glassbox/src/cli.mjs", "mcp"]
    }
  }
}
```

The shim is stateless and auto-starts the shared daemon on first use, so one shim per Claude session
(or subagent) is cheap and safe — the browser state lives in the daemon, not in the shim.

Fourteen tools: `gb_session`, `gb_goto`, `gb_act`, `gb_observe`, `gb_read`, `gb_verify`,
`gb_screenshot`, `gb_style`, `gb_eval`, `gb_wait`, `gb_debug`, `gb_coverage`, `gb_dialog`,
`gb_watch`. **`skill/SKILL.md` is the agent-facing manual** — session-per-agent pattern,
verify-first loop, debug recipes, PAUSED-lane rules. Copy it into `.claude/skills/` (or point your
agent at it) so the model learns the workflow, not just the schemas.

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

---

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
npm test              # all 12 proofs, 262 checks against a real browser (~17 min)
npm run test:m8       # the system-level pass: parallel stress, seed sweep, artifact contract
npm run test:m9       # defect round 1 regressions (each check fails on the pre-fix build)
npm run test:m10      # defect round 2 regressions (deferred content, cold/warm loads, 404 allowlist)
npm run test:m11      # defect round 3 regressions (collapsed <details>, clipped-capture framing)
npm run test:m12      # defect round 4 regressions (session ownership, scoped destroy verbs)
npm run test:live     # OPTIONAL, not in npm test: live check against a real Astro project
```

Each proof drives the real CLI/daemon against a real Chromium, and every one ends by asserting
`kill-all` leaves zero orphan processes. `test/bugzoo/` is the seeded-bug site the proofs verify
against — 17 deliberate bug classes plus a clean page as the false-positive check, plus the pages
seeded from the three field-defect rounds (occluded-but-clickable control, boot-time theme, Tailwind
class theme, modal backdrop, invisible drawer, delegated listeners, deferred `content-visibility`
sections, a request-counting cache page, a collapsed `<details>` accordion, and a UA-pseudo hide
no computed style can explain).

## Known limits (v1)

No cloud/remote browsers, no stealth or CAPTCHA anything, no cross-engine (BiDi) abstraction, no
performance-trace UI, no scraping ergonomics. React/Vue component-tree inspection is deliberately
out (version-fragile). macOS/Linux are unproven, not unsupported.
