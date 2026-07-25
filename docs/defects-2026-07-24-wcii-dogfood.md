# Glassbox defect log — WCII dogfood, 2026-07-24 (evening)

> **STATUS (2026-07-24): all 4 fixed**, plus the console-count observation. Pinned by checks that
> fail on the pre-fix build (`test/m10.mjs`, 19 checks; suite 233/233).
> W3's open question — "arch §4 says the cache is disabled, so why did cache effects appear?" — was
> measured, not assumed: `Network.setCacheDisabled(true)` **does** work (every renderer-initiated
> sub-resource is re-fetched on every navigation); what escapes it is Chrome's browser-process
> `/favicon.ico` probe (negatively cached per profile) and CLS being a first-paint race a warm load
> wins. No bonus defect. Per-defect detail: `docs/BUILD-LEDGER.md` Phase 7.
> **Deferred:** force-painting deferred sections during the *audit* pass (W1 stretch) — it would
> inject layout-shift entries into the same run's CLS measurement.

Source: visual-QA pass of the WCII building page (`/building/rise-west-campus`) driven entirely
through the Glassbox CLI (`src/cli.mjs`) while restructuring the page in the orchestrating session.
Dev server on `localhost:4327`; two sessions — `rise` (light, 1280w) and `rise-m` (390×844). Pages
exercised: one long Astro "case file" (~8000px desktop) built from `MobileSection` components that
carry `content-visibility: auto` on a `.defer` class, and a theme system driven by BOTH
`prefers-color-scheme` and a `data-theme` attribute stamped by a toggle button.

Defect IDs use a **W** prefix (WCII dogfood) so they don't collide with the D-series in
`defects-2026-07-24-degreeforge-dogfood.md` when the logs are aggregated. Severity: **MAJOR** =
produces a wrong verdict or masks a real bug; **MEDIUM** = noise that buries real findings, or a
right verdict for the wrong reason; **MINOR** = docs/ergonomics.

Related prior finding: DegreeForge **D5** already flagged `visibility:hidden` ancestors as
per-descendant "invisible interactive" noise. W1 below is the *`content-visibility: auto`* variant —
mechanically different and arguably a stronger false positive, because content-visibility elements
are meant to be seen (they paint on scroll); they are not hidden.

---

## W1 · MEDIUM — `content-visibility: auto` elements reported as "invisible interactive"

`verify` emitted **10** warnings on the building page:

```
[warn/layout] Invisible interactive element: svg.rent-svg — takes up 760×267px of layout but cannot be seen (content-visibility)
[warn/layout] Invisible interactive element: a — takes up 79×18px of layout but cannot be seen (content-visibility)   (×9)
```

Every one is a valid, keyboard-reachable element (rent-chart SVG, archived-receipt links, rent-point
links) sitting inside a `MobileSection` whose `.defer` class sets `content-visibility: auto`. Those
sections **do** render — I scrolled `rise-m` to `#reviews`/`#ownership`/`#timing` and each painted
its content and teaser correctly. So the verdict "cannot be seen" is wrong: they can, on scroll.

- The tool already *detects* the cause (it prints `(content-visibility)`), so the data to suppress
  or reclassify is in hand.
- `content-visibility: auto` is a **performance** primitive (skip rendering work while off-screen),
  not a hide primitive like `display:none`/`visibility:hidden`. It should not share their "deliberately
  hidden" treatment *or* their "accidentally hidden" alarm — the correct handling is a third bucket:
  "deferred; not yet painted."
- Fix direction: when the only reason an element is unpainted is a `content-visibility: auto`
  ancestor, either (a) force paint before measuring (scroll the ancestor into view, or set
  `content-visibility: visible` on it for the measurement pass), or (b) collapse the batch to one
  info line ("N elements in M deferred sections; scroll to audit"). Silent per-descendant warnings
  bury real invisibility findings in exactly the register D5 warned about.
- Repro: WCII building page at 1280w → `verify`. `.defer { content-visibility: auto }` in
  `src/components/MobileSection.astro`.

## W2 · MAJOR — `screenshot --full` stitches blank space over `content-visibility` sections

`screenshot --full -s rise` produced a **1280×8028** webp with roughly the bottom half rendered as
blank paper — the deferred sections reserve their `contain-intrinsic-size` height in layout but are
never painted during the full-page capture, so they stitch in empty. On mobile (`rise-m`, 390×6505)
the same capture showed a single ~3500px void between "Complaint records" and the footer.

- A screenshot is a *primary* agent observation. A reviewing agent that trusts the `--full` output
  concludes the page is broken or half its sections are missing — the exact opposite of the truth.
  (I only caught it because the DOM/verify said the sections existed, so I re-shot via `scroll --to`
  + viewport captures, which rendered everything perfectly.)
- This is more severe than W1: W1 is noise, W2 actively produces a misleading artifact.
- Fix direction: before a `--full` capture, walk the page to trigger paint (scroll top→bottom in
  viewport steps and let each settle), or temporarily set `content-visibility: visible` on every
  `content-visibility: auto` container for the capture then restore. CDP `Page.captureScreenshot`
  with `captureBeyondViewport:true` does not by itself force content-visibility paint.
- Repro: `screenshot --full -s rise` on the building page. Compare to `scroll --to "#timing"` then
  `screenshot` (viewport) — the latter is correct.

## W3 · MAJOR — `verify` on a warm reload silently drops cold-load findings (favicon 404 + CLS)

Two findings appeared on the **first** navigation and vanished on a **warm reload**, with nothing in
the report indicating the result is load-state dependent:

| finding | cold `verify` (verify-1) | warm reload `verify` (verify-2) |
|---|---|---|
| `GET /favicon.ico → 404` (console error + 2 net rows) | present | **gone** (browser doesn't re-request a cached negative) |
| CLS `0.1734` on `ol.profile-cites` | present | **gone** (web font cached → no first-paint reflow) |

- The danger is a **false all-clear**: an agent that does `goto` → (something) → `goto` again →
  `verify`, or that re-verifies after any warm navigation, gets `console=0 … layout=10` and reports
  the page clean. Both dropped findings are real and user-facing on first visit.
- CLS specifically is a first-load metric; measuring it after the font is cached will almost always
  read 0 and is close to meaningless.
- Fix direction: (a) label each `verify` with the navigation state it measured (cold nav vs warm/
  same-document), and (b) for CLS and first-request errors, run the leg against a **fresh** context
  or a cache-disabled cold navigation, or at minimum warn: "measured after warm load; first-load
  CLS and first-request 404s may be understated." Consider a `verify --cold` that opens a throwaway
  context per run.
- Repro: fresh session `goto` building page → `verify` (favicon + CLS present) → `goto` same URL →
  `verify` (both gone).

## W4 · MINOR — no expected-404 allowlist (reconfirm of backlog item)

`/favicon.ico → 404` is the headline line of every cold `verify`, pushing real findings down. Already
noted in BUILD-LEDGER ("no expected-404 allowlist yet"); reconfirmed here as real friction. A
`--ignore-404 /favicon.ico` flag or a per-project config allowlist would keep the report focused.
(Interacts with W3: don't let the allowlist also hide *unexpected* first-request failures.)

## Observations (not defects)

- **`console` count semantics, again.** `goto` reported `3 console`, the following `verify` printed
  `console=1`; the buffer's `read console` showed 2 vite logs + 2 favicon errors. Same field-name
  ambiguity flagged in the DegreeForge log's observations — `console=N` counts errors only. Rename to
  `consoleErrors` or document the window; the mismatch invites "did I lose messages?" every time.
- **Positive — the theme sweep worked here.** DegreeForge D2/D3 were about a site that boots its
  theme once and a Tailwind `class` strategy the sweep can't drive. WCII decides theme live from
  `prefers-color-scheme` **and** a `data-theme` attribute, and `verify --themes` drove both correctly:
  the light/dark viewport shots were genuinely different and matched the site's own toggle. Good
  evidence the emulation path is right when the *site* re-reads theme at runtime — which sharpens the
  D2 fix (reload per leg only for boot-once sites; detect and say so).
- **Positive — a11y catch was correct and actionable.** `verify` flagged `<hr>` as an invalid direct
  child of `<dl>` (axe rule) with the exact node; the fix (swap to a styled `<div>`) cleared it to
  `a11y=0` on re-verify. This is the tool doing exactly its job.
- **Positive — the debug/observe economics held.** Viewport `scroll --to` + `screenshot` was the
  reliable way around W2; artifact-path-on-disk (webp, path inline) kept the token cost sane across
  ~8 screenshots; `settle` after each scroll behaved.

---

*Filed by the WCII restructure session, 2026-07-24 evening. Repro app state: WCII branch
`home-ux-redesign`, building page `/building/rise-west-campus`, dev server `astro v5.18.2` on :4327.
W1/W2 both trace to `content-visibility: auto` on `src/components/MobileSection.astro` `.defer`.*
