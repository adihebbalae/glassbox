# Glassbox defect log — DegreeForge TASK-119 verification, 2026-07-26

> **STATUS (2026-07-26): D12 fixed, and the observation with it.** Sessions now record who opened
> them (`--client` > `GLASSBOX_CLIENT` > `anonymous`; the MCP shim uses `mcp-<pid>` automatically,
> so MCP agents get ownership with no configuration). `kill-all --mine` is the scoped end-of-task
> cleanup and leaves the daemon up for everyone else; a bare `kill-all`/`daemon stop` REFUSES with a
> structured `FOREIGN_SESSIONS` error naming the other clients while their sessions are live;
> `--force` keeps the machine-wide clean slate for wedge recovery. `NO_SESSION` now carries the
> daemon's pid + startedAt and the CLI prints it, so "the daemon churned under me" is one call
> instead of a journal dig. Both README and SKILL.md, which walked users into this, now teach
> `--mine` and label `--force` as a shared blast radius. Pinned by `test/m12.mjs` (14 checks, all
> verified to fail at 7c4ad7d); suite 262/262 across 12 proofs.
>
> One admission this round owes the filer: the **immediately preceding** defect round widened this
> exact hazard — its hygiene fix made bare `kill-all` reap every glassbox daemon on the machine by
> command-line match, and its own suite runs are a plausible candidate for the concurrent client
> that ended this session's work. That capability now lives behind `--force`. Detail:
> `docs/BUILD-LEDGER.md` Phase 9.
>
> Original filing follows.

Source: browser verification of DegreeForge TASK-119 (onboarding front-door + tour/dialog
sequencing), driven entirely through the Glassbox CLI (`src/cli.mjs`), multiple parallel sessions
against `http://localhost:5173` (dev) and `http://localhost:4173` (production `vite build` +
`vite preview`), desktop 1280×575, mobile 390×844, and a `--color dark` session. Severity scale
matches the prior dogfood log: **MAJOR** = wrong verdict / masks a real bug / silent destructive
failure; **MEDIUM** = noise; **MINOR** = docs/ergonomics.

---

## D12 · MAJOR — `kill-all` / `daemon stop` is an unscoped, silent, cross-agent destructive operation

Mid-verification, five active sessions (`df119`, `df119c`, `df119mobile`, `df119prod`,
`df119prod2`) vanished simultaneously with no warning. The next command against any of them
failed with `NO_SESSION: valid: (none)`. `daemon status` showed a **different pid and a different
port** than the one printed when I opened those sessions — the daemon itself had restarted.

Root cause, confirmed by reading each dead session's `journal.jsonl`:
```json
{"event":"destroy","reason":"shutdown"}
```
and by reading `src/daemon/daemon.mjs`: `POST /shutdown` (the endpoint `kill-all`/`daemon stop`
hit) tears down **every session in the shared daemon**, unconditionally, with no ownership check,
no "sessions in use elsewhere" warning, and no confirmation prompt. `%LOCALAPPDATA%\glassbox` is a
single machine-wide daemon (by design, per the architecture doc) — but the destructive verbs carry
no concept of "whose sessions are these." Listing `sessions/` on disk at the time showed **60+
session directories** from clearly unrelated concurrent work (`villas6`, `rise-v2`, `austin1`,
`par-clean`, timestamps minutes apart) — strong evidence another concurrent Glassbox client on the
same machine ran `kill-all` (or `daemon stop`) and silently took my in-progress verification down
with it.

- This is exactly the trap the tool's own docs walk users into: the README's troubleshooting
  section *recommends* `kill-all` for "everything is wedged / I want a clean slate," and the
  skill's own workflow doc says "reap everything... `glassbox kill-all`" as the standard end-of-task
  cleanup move — neither mentions that this is a **shared blast radius**, not a per-agent one. A
  multi-agent workflow (exactly this session's context — the parent task explicitly warns other
  subagents may share the daemon) has no safe global "clean slate" verb; the only safe cleanup is
  enumerating and `session rm`-ing your own named sessions one at a time.
- Impact realized here: ~15 minutes of verification work (screenshots, observe trees, a running
  tour walkthrough) had to be redone in fresh sessions. In a less attentive run this would produce
  a silent gap in coverage — a subagent whose sessions die mid-checklist has no signal *why*
  `NO_SESSION` started firing, and might report false failures or quietly skip remaining checks.
- Suggested fix direction: scope `kill-all`/`shutdown` to sessions owned by the CALLING client
  (e.g. a client-id header set at `session open` and threaded through), or at minimum have
  `kill-all` refuse / warn ("N sessions opened by other clients in the last 5 min — pass --force to
  proceed") before tearing down sessions it didn't create. A machine-wide daemon is a reasonable
  architecture choice, but a machine-wide *destroy* verb with no ownership model is not.
- Repro: run two independent `glassbox session open` sequences (simulating two agents) against the
  same machine, then `glassbox kill-all` from one of them — the other's sessions die with no
  notification to that process beyond the next command's `NO_SESSION`.

---

## Observations (not defects, worth a decision)

- **`session open` return doesn't surface daemon identity.** After the restart, nothing in normal
  command output would have told me the daemon had changed (only `daemon status`'s pid/port
  differing from the `session open` banner I'd scrolled past). A `daemon status`-style
  pid/uptime stamp on every response (or at least on the first error after a restart) would make
  "the daemon churned under me" diagnosable in one call instead of requiring a `journal.jsonl` +
  source-code spelunking session to confirm.
- **Everything else was flawless.** Across ~10 sessions, dozens of `click`/`eval`/`observe`/`verify`
  calls, two `--color dark` sessions, a `--viewport 390x844` mobile session, and cross-referencing
  `verify`'s network-taxonomy JSON against production/dev builds: no wrong verdicts, no missed
  console errors, `elementFromPoint`-equivalent occlusion reasoning (via `eval`) matched the
  screenshot evidence every time, and `observe`'s distilled tree was accurate and cheap. The one
  other near-miss (`offsetParent === null` reading as "not visible" on a Radix `position:fixed`
  dialog) was my own ad-hoc `eval` heuristic, not a Glassbox tool call — worth a note in the skill
  file (`offsetParent` is `null` for `position:fixed` elements per spec; prefer
  `getBoundingClientRect` + `elementFromPoint`, which Glassbox's own occlusion check already does
  correctly) but not filed as a defect since it didn't originate from any `gb_*`/CLI verb.

---

*Filed by the DegreeForge TASK-119 browser-verification subagent, 2026-07-26. Repro app state:
worktree `agent-a5d8f28c1490c69f4` (commits `0dde188`+`6537c10`), dev server on :5173, production
preview on :4173.*
