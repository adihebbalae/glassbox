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

- [x] Phase 7 — **Defect round 2 (WCII dogfood, 2026-07-24 evening)**. A visual-QA pass of the WCII
      building page (long Astro "case file" built from `content-visibility: auto` sections, theme
      driven by both `prefers-color-scheme` and `data-theme`) filed 4 defects + observations
      (`docs/defects-2026-07-24-wcii-dogfood.md`). All 4 fixed, pinned by `test/m10.mjs` (19/19).
      Suite is now **233/233** across 10 proofs.

      | # | Defect | Fix | Where |
      | --- | --- | --- | --- |
      | W1 | `content-visibility:auto` descendants reported as "invisible interactive" (10 warnings for links that render fine on scroll) | third bucket — **deferred**: one info line per container ("N interactive elements in deferred section …; scroll to audit"), never counted as pathology. `content-visibility:hidden` is treated as a deliberate hide, like display:none | `daemon/layout-audit.mjs`, `daemon/verify.mjs` |
      | W2 | `screenshot --full` stitched blank paper over deferred sections (a *misleading primary artifact*) | a full capture forces every `content-visibility:auto` subtree to paint first via an INSPECTOR stylesheet (no DOM node → no MutationObserver noise, refs survive), reports `forcedPaint:N`, restores exactly; `forcePaint:false` opts out | `daemon/extras.mjs` |
      | W3 | a warm reload silently dropped cold-load findings (favicon 404 + CLS 0.1734 → 0) | every report carries `navigation:{kind,reason,documentLoads,urlLoads}`; a warm measurement emits an explicit understatement warning; `cold:true` (`--cold`) clears the HTTP cache and re-navigates before measuring | `daemon/verify.mjs`, `daemon/sessions.mjs` |
      | W4 | no expected-404 allowlist — `/favicon.ico` headlined every cold verify | `ignore404` (session option + per-run `--ignore-404`, repeatable): matching **status-404** rows demote to an info count plus the browser's matching resource-load console error; kept on disk under `network.ignored404`; a 500 or transport failure on the same path still reports | `daemon/verify.mjs`, `daemon/sessions.mjs`, `cli.mjs`, `mcp-shim.mjs` |
      | obs | `goto`'s "3 console" vs verify's "console=1" | the action delta now says `5 console msgs (4 errors)`; verify's label was already fixed in round 1 | `cli.mjs` |

      **Cache-disable investigation (W3's open question) — answered, no bonus defect.** Measured with
      a counting fixture (`test/bugzoo/cache.html` + `/counts`, asserted in m10 W3d/W3e):
      `Network.setCacheDisabled(true)` IS applied and DOES work — a `max-age=600` script is re-fetched
      on **every** navigation (4 loads → 4 server hits). What escapes it is (a) Chrome's `/favicon.ico`
      probe, issued by the BROWSER process outside the page session's Network domain and negatively
      cached per profile (4 loads → 3 requests, and none at all in a later session), and (b) CLS,
      which is a race between first paint and a resource arriving — a warm load wins it even with a
      cold cache. Neither is reachable by a flag, which is exactly why W3's answer is *label + warn +
      offer a real cold run* rather than "turn the cache off harder".

      New bug-zoo pages: `deferred.html` (content-visibility:auto section + a content-visibility:hidden
      control), `cache.html` (counted cacheable sub-resources, a 404 favicon and a renderer-initiated
      404); `serve.mjs` gained `/count/*`, `/counts`, `/reset-counts`, `/favicon-404.ico`.
      **Deferred:** force-painting deferred sections during the AUDIT pass (W1 stretch) — forcing
      layout mid-measurement would inject `layout-shift` entries into the buffered CLS observer and
      corrupt the very number the same pass reports, so deferred sections stay "scroll to audit";
      and the "theme responded without reload" detection (round-1 D2 sharpening) — the sweep would
      have to measure both ways to know, which doubles every sweep to save one reload.

- [x] Phase 8 — **Defect round 3 (WCII villas-on-rio dogfood, 2026-07-25)**. A pass over a second
      WCII building page, served from the built `dist/` by `astro preview`, filed 2 defects
      (`docs/defects-2026-07-25-wcii-dogfood.md`) and re-confirmed all four round-2 fixes live.
      Both fixed, pinned by `test/m11.mjs` (15/15). Suite is now **248/248** across 11 proofs.

      | # | Defect | Fix | Where |
      | --- | --- | --- | --- |
      | W5 | interactive content in a CLOSED `<details>` reported as 10 × "invisible … (content-visibility)" — wrong count register AND a cause the computed styles contradict (the UA `::details-content` pseudo is not in the parentElement chain) | fourth bucket — **collapsed**: `closest('details:not([open])')` (and `[hidden="until-found"]`, same family) collapses the descendants into ONE info line per widget, naming it and its summary text, never counted as pathology | `daemon/layout-audit.mjs`, `daemon/verify.mjs` |
      | W5b | the same code asserted `content-visibility` for ANY unexplained hide | when nothing in the DOM ancestor chain explains it, the finding now says the cause is *outside* the chain (a UA pseudo-element or shadow root) instead of naming a mechanism every ancestor's computed style contradicts | `daemon/layout-audit.mjs` |
      | W6 | `screenshot --selector` returned a silently BLANK clip "for the rest of the session once any `<details>` had been opened" | the clip is now converted to PAGE coordinates and captured with `captureBeyondViewport`+`fromSurface`; the selector path also force-paints (`content-visibility:auto` content clipped blank exactly like the full-page case); and a featureless clip of a visible element with content returns an explicit `warning` instead of a silent blank | `daemon/extras.mjs`, `cli.mjs` |
      | hyg | `kill-all` could not reap a daemon whose discovery file was gone, and reported "chromium N -> 0" while the processes were still terminating | daemons are found by command line (PID-verified) like chromium always was; the chromium count polls until the kill really lands; a failed WMI query retries instead of returning the reassuring zero | `daemon/prockit.mjs`, `cli.mjs` |

      **W6's filed root cause was wrong, and the measurement says so.** The log blamed a compositor
      state left live by the `::details-content` transition, with `DOM.getBoxModel` returning
      document-absolute coordinates as an "adjacent latent issue". Measured (raw CDP, this repo's
      Chromium): `DOM.getBoxModel` returns **viewport-relative** coordinates — y = -1500 at
      scrollY 1500, exactly like `getBoundingClientRect` — while `Page.captureScreenshot` wants the
      clip in **page** coordinates. The two agree only at scroll 0. The `<details>` was innocent:
      clicking its summary SCROLLS it into view, and every clip taken afterwards was framed against
      the wrong origin — which is why the blank persisted for the session (the page stays scrolled),
      why a re-navigation "fixed" it (scroll resets), and why clip-less viewport shots were immune.
      Reproduced with no `<details>` at all: `scrollTo(0,1500)` alone is enough. Parameter matrix:
      page coords + `captureBeyondViewport` is correct in every case (6380 B / 24626 B); viewport
      coords are wrong whenever scrollY ≠ 0 (462 B / 970 B).

      New bug-zoo pages: `details.html` (a closed `<details>` with 10 interactive descendants, a
      `hidden="until-found"` region, a second `<details>` inside a `content-visibility:auto` section,
      and a visible-but-featureless box for the blank-clip guardrail) and `pseudo-hide.html` (an OPEN
      `<details>` frozen shut by author CSS on the UA pseudo — the residual case behind the honesty fix).
      **Deferred:** nothing from this round. The blank-clip floor is a heuristic (√area, calibrated on
      five measured captures) and is recorded as such — it warns, never fails.

## Known limitations (v0.1.0 + defect rounds 1-3)
- display:none (and content-visibility:hidden) treated as deliberate — an accidentally-hidden
  element won't be flagged; win32-only proven; parallelism tested at 4 sessions; live-wcii check
  is manual, not CI-gated.
- While ANY modal is open, occlusion warnings outside it are suppressed (counted, not listed) —
  a genuine z-order bug elsewhere on the page hides behind that one info line until the modal closes.
- The click hit-point probe covers click/dblclick; `hover` still relies on Playwright's own
  actionability. React-Flow edge hit-areas and thin SVG groups remain permanent low-value warnings.
- `verify --cold` is a cold CACHE, not a cold PROFILE: cookies/localStorage survive (deliberately —
  it must not log you out), and Chrome's browser-process favicon cache is out of CDP's reach, so a
  first-visit `/favicon.ico` 404 only ever appears once per browser. A fresh session is the only
  true cold start for that one.
- Contrast/occlusion INSIDE a `content-visibility:auto` section are not audited until it is scrolled
  into view, and inside a collapsed `<details>` / `hidden="until-found"` region until it is opened
  (both info lines say so). Opening every disclosure automatically would change page state the
  caller did not ask to change.
- `verify --themes` reloads per leg, so in-page state (filled forms, opened panels) is lost unless
  `themeReload:false` is passed.
- The blank-clip warning is a HEURISTIC (bytes below a √area floor, on an element that reports
  itself visible with text or media). A legitimately featureless element that carries text — e.g.
  transparent text on a matching background — will trip it; that is a real UI smell, but it is a
  warning in the result, never a failure.
- `kill-all` reaps daemons by command-line match, so it takes down EVERY glassbox daemon on the
  machine, not just this checkout's. That is the singleton contract (one daemon, one browser pool),
  but it means two working copies cannot run suites side by side.

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
