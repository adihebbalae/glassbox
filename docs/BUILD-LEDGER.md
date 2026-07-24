# Glassbox build ledger

Session-durable state. Any agent resuming cold: read `docs/00-first-principles.md` first,
then this file top to bottom. Update this file at every phase boundary.

## Mission
Purpose-built local browser for agentic UI verification (Claude Code native). Full mandate
from Adi 2026-07-23 ~1am: first principles → sonnet research fleet → plan → opus build
agents → tested working system. Session runs in WCII worktree (`glassbox-build`) but the
project lives here, its own repo (`main`).

## Phase status
- [x] Phase 0 — First principles written (`docs/00-first-principles.md`)
- [x] Phase 0.5 — Feasibility spikes (`spikes/SPIKES.md`): zero-dep CDP, debug plane,
      observation economics — all PASS
- [x] Phase 1 — Research fleet: 8/8 sonnet reports in `docs/research/` (1.01M tokens)
- [x] Phase 2 — Architecture decided (`docs/01-architecture.md`): Playwright lib +
      CDPSession escape hatch; daemon + named-context sessions; CLI+MCP duality
- [x] Phase 3 — Build plan (`docs/02-build-plan.md`): milestones M1–M8
- [x] Phase 4 — ALL milestones complete: M1 (10/10) → M2 (12/12) → M3 (26/26) →
      M4 (23/23) → M6 (19/19) → M5 (23/23) → M7 (32/32, dev-loop) → M8 (39/39,
      hardening + full-system). Suite `npm test` = **184/184 green × 2 consecutive runs**,
      zero flakes, zero chromium orphans. Tagged **v0.1.0**.
- [x] Phase 5 — validated vs live WCII (test/live-wcii.mjs 9/9, not in npm test) AND
      dogfooded from the orchestrating Claude session against https://wcii.pages.dev/:
      session/goto/verify --themes/observe/style/screenshot/kill-all all correct.
      **Found a real production bug: wcii.pages.dev/favicon.ico → 404** (console error +
      2 httpError rows). README written; memory file written.

## Known limitations (v0.1.0)
- display:none treated as deliberate (mobile-nav lesson) — an accidentally-hidden element
  won't be flagged; no expected-404 allowlist yet; win32-only proven; parallelism tested
  at 4 sessions; live-wcii check is manual, not CI-gated.

## Decisions log
- 2026-07-23: Name = Glassbox. Repo at `C:\Users\boomb\Documents\_Projects\glassbox`.
- 2026-07-23: Rendering engine is a commodity (Chromium via CDP); we build the shell,
  session model, instrumentation, interfaces. Engine-management strategy left open for
  research (Playwright-managed vs raw CDP vs Electron).

## Environment facts
- Windows 11, Node v24.9.0, npm 11.6.0. Playwright Chromium builds already cached in
  `%LOCALAPPDATA%\ms-playwright` (chromium-1208/1223 + headless shells).
- Existing tool: `C:\Users\boomb\browser-harness` (Python CDP bridge into user's own
  Chrome; single-session; its SKILL.md is the anti-spec — see first-principles §4).
