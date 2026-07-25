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

- [x] Phase 6 — **Defect round 1 (DegreeForge dogfood, 2026-07-24)**. A full visual-QA pass of a
      real Vite/React/Tailwind/shadcn/React-Flow app, driven entirely through the CLI, filed 11
      defects + observations (`docs/defects-2026-07-24-degreeforge-dogfood.md`). All 11 fixed,
      each pinned by a check that fails on the pre-fix build (`test/m9.mjs`, 30/30). Suite is now
      **214/214** across 9 proofs.

      | # | Defect | Fix | Where |
      | --- | --- | --- | --- |
      | D1 | `act click` force-clicked targets a real pointer can't reach (contradicted `verify`) | hit-point probe before click/dblclick using the SAME rule as the layout audit → structured `ACT_OCCLUDED` naming the coverer; explicit `--force`/`force:true` stamps `forced:true` + `occludedBy` into the delta and journal | `daemon/actions.mjs`, `protocol.mjs` |
      | D2 | `--themes` dark screenshot was silently the light one (boot-time theme readers) | each theme leg now RELOADS after setting emulation (`themeReload:false` opts out); byte-identical light/dark shots are emitted as a `theme` finding | `daemon/verify.mjs` |
      | D3 | no support for Tailwind `darkMode:['class']` | `themeClass` session option (CLI `--theme-class`, MCP `gb_session`), toggled on `<html>` per leg beside `themeAttr` | `daemon/sessions.mjs`, `daemon/verify.mjs` |
      | D4 | modal backdrops produced ~10 occlusion false positives | an open `aria-modal`/`role=dialog`/`dialog[open]` collapses everything behind it into ONE info line (`modal:{desc,behind}`), never counted as pathology | `daemon/layout-audit.mjs`, `daemon/verify.mjs` |
      | D5 | `visibility:hidden` ancestor flagged once per descendant (10 warnings for one closed drawer) | descendants hidden by an ancestor group into one finding naming that ancestor with a count; self-hidden elements still report individually | `daemon/layout-audit.mjs` |
      | D6 | `debug listeners` silently inspected the first match and misdiagnosed React delegation as "dead" | echoes the inspected node, warns on `matchCount>1`, walks ancestors for delegated handlers, and returns an explicit `verdict` | `daemon/debug.mjs`, `cli.mjs` |
      | D7 | `wait --url "/planner"` timed out (SKILL's own example) | leading-`/` patterns match the PATHNAME at a segment boundary (`*` globs); CLI un-mangles Git-Bash/MSYS path rewriting of `--url /x` | `daemon/extras.mjs`, `cli.mjs` |
      | D8 | `session open` didn't print the promised watch URL | printed (and in `--json`) at open | `cli.mjs` |
      | D9 | viewport-sweep artifacts named `theme-*` | named by the axis actually swept: `vp-mobile`, `dark`, `dark-vp-mobile` | `daemon/verify.mjs` |
      | D10 | a plain sleep was clipped by the action budget (`sleep 15000` → "MATCHED in 10000ms") | a sleep owns its own budget, reports `slept`, always succeeds/exits 0; the CLI's HTTP budget follows the sleep | `daemon/extras.mjs`, `cli.mjs` |
      | D11 | no viewport-resize for a live session | `session resize <name> WxH` / `POST /sessions/:name/viewport`, folded into `gb_session {op:"resize"}` — **still exactly 14 MCP tools** | `daemon/extras.mjs`, `cli.mjs`, `mcp-shim.mjs` |
      | obs | verify's `console` count read as "all console output" | labelled `consoleErrors` everywhere + documented window (since the last navigation) | `cli.mjs`, docs |
      | obs | `scroll --to` on a visible target read as "scrolled" | echoes `already in view (no scroll needed)` vs `scrolled into view` | `daemon/actions.mjs` |

      New bug-zoo pages: `occlusion.html` (occluded-but-clickable control), `boot-theme.html`,
      `class-theme.html`, `modal.html`, `drawer.html`, `delegate.html`.
      **Deferred:** the React-Flow same-component hit-area exemption (edges flagged occluded by
      their own invisible `.react-flow__edge-interaction` path, and thin-path SVG groups measuring
      ×0) — no generic rule that doesn't also excuse two genuinely overlapping siblings; and the
      React-fiber `onClick` source for `listeners` (still points at react-dom internals) — both
      logged as backlog by the defect report itself.

## Known limitations (v0.1.0 + defect round 1)
- display:none treated as deliberate (mobile-nav lesson) — an accidentally-hidden element
  won't be flagged; no expected-404 allowlist yet; win32-only proven; parallelism tested
  at 4 sessions; live-wcii check is manual, not CI-gated.
- While ANY modal is open, occlusion warnings outside it are suppressed (counted, not listed) —
  a genuine z-order bug elsewhere on the page hides behind that one info line until the modal closes.
- The click hit-point probe covers click/dblclick; `hover` still relies on Playwright's own
  actionability. React-Flow edge hit-areas and thin SVG groups remain permanent low-value warnings.
- `verify --themes` reloads per leg, so in-page state (filled forms, opened panels) is lost unless
  `themeReload:false` is passed.

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
