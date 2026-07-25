# Glassbox defect log — DegreeForge dogfood, 2026-07-24

Source: full visual-QA pass of DegreeForge (localhost:5173) driven entirely through the Glassbox CLI
(`src/cli.mjs`), two parallel sessions (`df-dogfood` light 1280×575, `df-dark` dark), pages: `/`,
`/planner`, `/map` (Required + All-ECE, 233 nodes/478 edges), `/progress`, `/professors`, plus a
mobile+desktop viewport sweep. Every defect below was reproduced during the run; repro commands are
against a real Vite/React/Tailwind/shadcn/React-Flow app.

Severity: **MAJOR** = produces a wrong verdict or masks a real bug (the tool's core promise);
**MEDIUM** = noise that buries real findings; **MINOR** = docs/ergonomics.

---

## D1 · MAJOR — `act click` force-clicks targets a real pointer cannot reach

`verify` correctly flagged `.react-flow__controls-zoomin` as *occluded* (covered by a legend `ul`
with `pointer-events:auto`; `document.elementFromPoint` at the button's center returns the legend).
Yet `click .react-flow__controls-zoomin` returned **`click ok — 520 mut`** and the zoom actually
executed. A real user clicking there hits the legend, never the button.

- The two tools contradict each other, and `act` is the one lying. Had I trusted `act` alone, the
  host app's buried-controls bug would have been invisible.
- Expected: actionability failure (Playwright's default intercept check), or at minimum a
  `forced:true` / `occludedBy:<selector>` field in the delta. A verification browser must never
  silently perform an interaction the user can't.
- Repro: DegreeForge `/map` at 1280×575 → `click .react-flow__controls-zoomin`.

## D2 · MAJOR — `verify --themes` dark screenshot is silently the light theme

On a site that decides theme **once at boot** (reads `prefers-color-scheme` at module load, applies
a class — DegreeForge's `useTheme.ts`, and a very common pattern), the sweep's runtime emulation
flip changes nothing: `verify-1-dark-vp.webp` was pixel-identical to light. No warning, no error —
a dark-mode reviewer gets false confidence from a wrong artifact.

- Proof it's the sweep, not the site: a session opened with `--color dark` renders the site fully
  dark on first load.
- Fix direction: reload the page for each theme leg (or detect "shots identical" and say so in the
  findings — identical light/dark output is itself a signal worth reporting).

## D3 · MAJOR — no support for Tailwind class-strategy dark mode

`--theme-attr` drives an attribute (`data-theme`). Tailwind's default dark strategy —
`darkMode: ['class']`, toggling `class="dark"` on `<html>` — cannot be swept at all. That is
arguably the single most common dark-mode mechanism in the ecosystem Glassbox targets. Needs a
`themeClass` sibling option (add/remove a class on the root element per leg).

## D4 · MEDIUM — modal backdrops generate mass occlusion false positives

With a Radix dialog open (`role=dialog`, `aria-modal`, full-screen backdrop), `verify` emitted 10
"Occluded interactive element: … covered by div.fixed.inset-0" warnings for nav links/buttons
behind the backdrop. That's intended modal behavior; the noise buried the *real* occlusion finding
on the same page (D1's buried map controls read identically to backdrop noise until inspected).
Suggest: when the covering element is (or is inside) an open `aria-modal`/`role=dialog` overlay,
collapse the batch to one info line ("modal open; N elements behind backdrop").

## D5 · MEDIUM — deliberately-invisible ancestors flagged per-descendant

A closed drawer hidden via Tailwind's `.invisible` (`visibility:hidden` on the ancestor) produced
**10** "Invisible interactive element" warnings — one per descendant button/input — on every planner
verify. BUILD-LEDGER already treats `display:none` as deliberate; an ancestor with
`visibility:hidden` (esp. via the `.invisible` utility class) deserves the same treatment, or at
least grouping into one warning naming the hidden ancestor. (`gb style` correctly traced the
inheritance — the data to group by is already available.)

## D6 · MEDIUM — `debug listeners` picks a silent first-match and misdiagnoses React delegation

`debug listeners "button"` on the dashboard returned **"no event listeners (dead element)"**.
Reality: the selector matched the *first* DOM `button` (a hidden mobile hamburger), not any button
of interest, and the output never identifies which element it inspected. Meanwhile a precise ref
(`--ref e22`, the working "Open planner" button) shows its click listener fine, and `#root` shows
React's delegated set.

- Two fixes: (1) echo the matched element (tag/id/classes/text) and warn when the selector matched
  N>1 nodes; (2) before printing the "dead element" verdict, check ancestors for delegated
  listeners (React 17+ attaches everything at the root container) and say "no direct listeners;
  ancestor #root has delegated click/…" instead. The skill's flagship recipe
  ("empty list = no handler wired") returns a **wrong verdict** in this trap.
- Enhancement (backlog): for React apps the useful answer is the component's fiber prop
  (`onClick` source), not react-dom internals — all listener locations currently point at
  `react-dom.development.js`.

## D7 · MEDIUM — `wait --url` fails on leading-slash patterns

On a page already at `http://localhost:5173/planner`:
- `wait --url "/planner"` → **timed out, matched:false** (8s)
- `wait --url "planner"` → MATCHED in 2ms
- `wait --url "http://localhost:5173/planner"` → MATCHED in 3ms

The leading-slash form is the most natural way to write it, and **SKILL.md's own worked example
uses `for:{url:"/dashboard"}`** — the documented pattern doesn't work. Likely the pattern is fed to
Playwright's `waitForURL` glob matching where `/planner` must match the full URL. Fix the matcher
(treat a leading-`/` pattern as a pathname match) or fix the docs — currently they disagree with
the implementation in the failing direction.

## D8 · MINOR — `session open` (CLI) doesn't print the promised watchUrl

SKILL.md: open "→ info + a watchUrl for humans". CLI prints only
`session 'name' open (headless)`. Either print the watch URL at open (it's the human-facing hook)
or amend the doc to say it comes from `watch`.

## D9 · MINOR — viewport-sweep artifacts are named "theme-*"

`verify --viewports` writes `verify-7-theme-mobile.webp` / `verify-7-theme-desktop.webp`. The axis
swept is viewport, not theme; with `--themes --viewports` combined this naming will collide or
mislead. Name by the axis actually swept (`verify-7-vp-mobile.webp`).

## D10 · MEDIUM — `wait --sleep` semantics are inconsistent (added from the TASK-129 verify run)

`wait --sleep 700` → prints `wait — MATCHED in 700ms`, exit 0. `wait --sleep 500` → prints
`error [ACT_TIMEOUT]: action timed out: waiting 500ms`, nonzero exit — which breaks `&&` chains.
A plain sleep has nothing to "match" or "time out"; it should always succeed after the duration.
Whatever internal timeout races the sleep duration needs to exclude the sleep case (suspect:
sleep duration compared against a default action timeout with unfortunate rounding).

## D11 · MINOR — no viewport-resize command

Viewport is fixed at `session open`. Mobile checks on an existing session require opening a second
session and re-navigating/re-seeding state (playwright-mcp has `browser_resize`). A
`session set-viewport WxH` (or `resize`) command would make theme×viewport matrices much cheaper.

## Observations (not defects, worth a decision)

- **`verify` console count vs buffer**: `goto` reported "5 console" but the subsequent `verify`
  printed `console=0` while the buffer held 2 React Router deprecation warnings. Presumably verify
  counts only errors (or only its own window) — fine, but the field name `console` invites
  misreading. Label it `consoleErrors` or document the window.
- **`scroll --to` if-needed semantics**: on a target already visible it reports `ok — 0 mut`.
  Correct, but easily read as "scrolled". Consider echoing "already in view".
- **React Flow edge self-occlusion**: edges are flagged occluded by their *own* invisible wide
  hit-area path (`.react-flow__edge-interaction`) and as zero-size targets (SVG group of a thin
  path measures ×0). Same-component hit-area siblings could be exempted; currently every React
  Flow page carries ~4 permanent warnings.
- **Positive**: `style` nailed a root cause in one call (inherited `visibility:hidden ←
  .invisible`, cascade + specificity all correct); `observe` distillation is excellent (32-node
  tree, valid refs); structured errors (`ACT_TIMEOUT` with hint) behaved as documented; two
  parallel sessions ran interleaved without interference; artifact-path economics (webp on disk,
  paths inline) worked exactly as designed; `eval` surfaces in-page throws cleanly with stacks.

---

*Filed by the DegreeForge QA session, 2026-07-24. Repro app state: DegreeForge master `21222e5`,
demo profile loaded via "Explore the demo".*
