# Glassbox — build plan

*Milestones are dependency-ordered; each ends with a runnable proof (a script under `test/`
that exercises the milestone against a real browser). An engineer agent implements ONE
milestone, runs its proof, and leaves the tree green. Read `docs/01-architecture.md` first;
consult `docs/research/` for depth; `spikes/` shows working CDP code patterns.*

## Repo layout (target)

```
glassbox/
  package.json            # type:module, dep: playwright; bin: glassbox
  src/
    daemon/
      daemon.mjs          # entry: control plane (HTTP+WS), discovery file, lifecycle
      sessions.mjs        # SessionManager: name → context/page/cdp/buffers/artifacts
      settle.mjs          # composite quiescence (arch §4)
      journal.mjs         # JSONL journal + artifact dir helpers
      buffers.mjs         # console/network/error ring buffers + taxonomy (arch §5)
      verify.mjs          # verification engine (arch §5)
      layout-audit.mjs    # injected JS payload source (single string)
      overlay-reader.mjs  # vite/astro/next shadow-DOM error overlay extraction
      debug.mjs           # debug plane (arch §6)
      style.mjs           # cascade/why introspection + specificity computation
      observe.mjs         # hybrid DOM+AX distilled snapshot + ref registry
      screencast.mjs      # watch channel (arch §7)
      sourcemaps.mjs      # stack remapping
    cli.mjs               # `glassbox` bin — verbs → daemon HTTP; auto-start daemon
    mcp-shim.mjs          # stdio JSON-RPC MCP server → daemon HTTP proxy
    protocol.mjs          # shared: request/response types, error codes, tool schemas
  vendor/axe.min.js       # pinned axe-core
  test/                   # per-milestone proofs + bug-zoo site
    bugzoo/               # static site with seeded bugs (see M8)
  skill/SKILL.md          # Claude Code skill teaching Glassbox usage
```

## Milestones

### M1 — daemon spine: lifecycle, sessions, control plane  *(foundation)*
`daemon.mjs`, `sessions.mjs`, `journal.mjs`, start of `protocol.mjs`, `cli.mjs` (subset).
- Launch shared headless Chromium via Playwright; lazy headed instance on demand.
- SessionManager: `create/list/destroy/info` named sessions (BrowserContext + page + CDP
  session + artifact dir `%LOCALAPPDATA%\glassbox\sessions\<name>\` + journal). Per-session
  serial command queue; cross-session parallel.
- HTTP+WS control plane on `127.0.0.1:0` + 32-byte bearer token; atomic `daemon.json`
  discovery file; liveness = ping + `Target.getTargets` probe; single-instance lock;
  idle-session GC (configurable TTL); `glassbox kill-all` reaper + startup orphan sweep
  (tag via `--user-data-dir` marker). Windows: rely on Playwright cleanup + verify no
  zombies in proof.
- CLI: `glassbox daemon start|stop|status`, `session open|ls|rm`, auto-start-on-demand.
- **Proof `test/m1.mjs`**: cold CLI call auto-starts daemon; 4 parallel sessions created
  concurrently; storage isolation (spike-1 check); daemon restart recovers discovery; kill
  leaves zero chrome.exe orphans (count before/after).

### M2 — act + observe: grounding, settling, deltas
`observe.mjs`, `settle.mjs`, action endpoints, `buffers.mjs` (skeleton).
- Actions: goto, click, type, press, hover, scroll, drag, upload, select — Playwright
  locators; targets: CSS / test-id / role+name / text / snapshot ref (`e12`).
- Distilled hybrid DOM+AX snapshot with numbered refs → backendNodeId registry; refs
  invalidate on mutation (structured `STALE_REF` error with re-observe hint). Scoped
  observe (`selector:`) + pagination.
- Composite settle (arch §4) incl. Astro island signal; every action returns delta {url?,
  consoleSince, dialogState, blockedBy?, mutationSummary, settled}.
- Dialog interception: auto-surface pending dialog in every response; `dialog` endpoint
  responds; never hang (playwright-mcp #595 anti-pattern).
- Per-tab defaults: bypass SW + cache disabled.
- **Proof `test/m2.mjs`**: against a local test page — selector click, ref click,
  stale-ref error round-trip, dialog non-hang, type+submit, settle on a delayed-JS page.

### M3 — verification engine
`verify.mjs`, `layout-audit.mjs`, full `buffers.mjs`, `sourcemaps.mjs`, `overlay-reader.mjs`,
vendored axe.
- Everything in arch §5. Report shape: compact JSON (counts + top findings + artifact
  paths); full detail on disk. Theme sweep hooks: `emulateMedia` + optional site adapter
  (`data-theme` attribute name configurable per session).
- **Proof `test/m3.mjs`**: run `verify` against bug-zoo (build it now, see M8 list) — must
  catch every seeded bug class; clean page yields clean report (no false-positive flood).

### M4 — white-box debug plane  *(parallel-safe with M5/M6)*
`debug.mjs`, `style.mjs`, coverage.
- Arch §6 complete. Breakpoint set resolves via getPossibleBreakpoints; paused-state
  endpoint returns frames + scopes (distilled); evaluateOnCallFrame; screenshot-while-
  paused; JS+CSS coverage with source-mapped never-ran report; `style` why-tool with
  computed specificity + inheritance + contrast; DOMDebugger.getEventListeners.
- **Proof `test/m4.mjs`**: breakpoint in bug-zoo handler → pause → read local var
  (correctly, past the spike-2 off-by-one) → screenshot → sibling session stays live →
  resume; coverage flags a never-called handler; style explains the white-on-white seed.

### M5 — MCP shim + full CLI + skill
`mcp-shim.mjs`, `cli.mjs` completion, `protocol.mjs` finalized, `skill/SKILL.md`.
- ~14 tools per arch §8, structured isError shape, pagination, path-returns for images.
  Hand-rolled stdio JSON-RPC (initialize/initialized, tools/list, tools/call; pin current
  MCP protocol version; graceful on unknown methods).
- CLI: human-readable + `--json`; `GLASSBOX_SESSION` env default.
- SKILL.md: when to use, session-per-agent pattern, verify-first workflow, debug recipes.
- **Proof `test/m5.mjs`**: scripted MCP handshake over stdio (initialize → tools/list →
  tools/call verify) asserting protocol-correct frames; CLI end-to-end on bug-zoo.

### M6 — ride-along watch  *(parallel-safe with M4/M5)*
`screencast.mjs` + daemon-served watch page.
- WS screencast (ack-per-frame, CSS×DPR sizing), input forwarding, session grid page,
  DevTools link (documented `?ws=` pattern; vendoring the frontend optional/deferred).
- **Proof `test/m6.mjs`**: connect WS client, count frames during scripted scroll ≥ N;
  forwarded click lands (page state changes).

### M7 — dev-loop integration
- `glassbox dev` helper: spawn dev command, regex stdout for ready-URL (Playwright
  webServer pattern), attach session, surface overlay errors via M3 reader; HMR
  awareness: full-reload/error events reflected in `read` output where detectable.
- **Proof `test/m7.mjs`**: against a scratch Vite app — introduce a syntax error, `read`
  surfaces the overlay error text; fix, verify clean.

### M8 — end-to-end validation + hardening pass
- Bug-zoo final: seeded bugs = console error, unhandled rejection, 404 asset, 4xx fetch,
  hanging request, horizontal overflow, white-on-white text, zero-size button, occluded
  button, broken image, dead (no-handler) button, aria-less icon button, dark-theme-only
  regression, CLS shifter, native dialog, Astro-island hydration delay (or simulated).
- Full-system run: 4 parallel sessions × verify on bug-zoo; WCII dev server live check;
  MCP smoke from a real Claude Code config; zombie sweep assertion; README.
- Exit criteria: all proofs green in one `npm test` run; zero orphan processes; verify
  catches 100% of seeded classes with < 2 false positives on the clean page.

## Build execution notes
- Engineer agents: **opus**, one milestone each, sequential M1→M2→M3, then M4/M6 in
  parallel, then M5, M7, M8. Each agent: implement → run proof → fix until green → concise
  BDR commit. No Co-Authored-By trailers ever.
- Style: plain Node 24 ESM, no TypeScript build step, JSDoc types where they pay. Small
  files, no framework, no config system beyond env + flags (harness lesson: don't grow a
  manager layer beyond what the job needs).
- Playwright pin: latest 1.5x; browsers may re-download if cache revision differs — fine.
