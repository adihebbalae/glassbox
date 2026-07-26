# Glassbox defect log — WCII dogfood, 2026-07-25

> **STATUS (2026-07-26): both fixed.** W5 and W6 are closed, pinned by checks that fail on the
> pre-fix build (`test/m11.mjs`, 15 checks; suite 248/248 across 11 proofs). One correction the
> measurements forced: **W6's root cause is not the `<details>` and not a compositor state** — it is
> the clip's coordinate basis. `DOM.getBoxModel` returns VIEWPORT-relative coordinates while
> `Page.captureScreenshot` wants PAGE coordinates, so every clip taken after any scroll was framed
> against the wrong origin; clicking a `<summary>` scrolls it into view, which is why the toggle
> looked causal. `scrollTo(0,1500)` alone reproduces it with no `<details>` on the page. The fix
> converts the basis, captures beyond the viewport, force-paints the selector path too, and warns
> on a featureless clip. Per-defect detail: `docs/BUILD-LEDGER.md` Phase 8.
>
> Original filing follows.
>
> **2 new findings — W5 (MEDIUM, confirmed) and W6 (MAJOR,
> confirmed + minimized to one command).** Plus a clean re-confirmation that the
> 2026-07-24 round (W1–W4) landed: the `content-visibility:auto` reclassification, the
> `--full` force-paint, the cold-vs-warm labeling, and the `--ignore-404` allowlist all
> work as shipped (see "Re-confirmations" below). Neither new finding is a WCII page bug —
> the villas-on-rio page itself verified clean (`consoleErrors=0 pageerr=0 net(failed=0)
> a11y=0`, cold, both themes).

Source: visual-QA pass of a **second** WCII building page (`/building/villas-on-rio`) driven
through the Glassbox CLI while shipping a copy cleanup. This page renders the Wayback
rent-history scatter (section 3.5b) — a `MobileSection` (`.defer` = `content-visibility:auto`)
that contains a **closed `<details class="disclose">`** ("Show the rent chart & receipts")
wrapping the chart SVG + a receipts table of archived-snapshot links. Server was `astro
preview` on the **built `dist/`** (production output, not dev) at `localhost:4332`. Sessions:
`villas` (the working session) plus `villas2`–`villas6` (throwaway bisection sessions).

Defect IDs continue the **W** series from `defects-2026-07-24-wcii-dogfood.md` so the logs
don't collide when aggregated. Severity: **MAJOR** = produces a wrong verdict or a misleading
primary artifact; **MEDIUM** = noise that buries real findings, or a right verdict for the
wrong reason; **MINOR** = docs/ergonomics.

W1 (the 07-24 finding) was about `content-visibility:auto` and is fixed. W5 below is a
*different* invisibility mechanism — a closed native `<details>` — that the W1 fix does not
catch, because it hides through a pseudo-element the ancestor walk can't see.

---

## W5 · MEDIUM — interactive content inside a closed `<details>` is reported as N "invisible (content-visibility)" false positives

`verify --cold` on the villas page emitted **10** layout warnings:

```
[warn/layout] Invisible interactive element: svg.rent-svg — takes up 760×248px of layout but cannot be seen (content-visibility)
[warn/layout] Invisible interactive element: a — takes up 100×18px of layout but cannot be seen (content-visibility)   (×9)
```

Every one is the rent-chart SVG or an archived-receipt link sitting inside a **closed**
`<details class="disclose">`. They are not pathology: they paint the instant a user opens the
disclosure, exactly as `content-visibility:auto` content paints on scroll (the W1 case).

**Proven, not assumed** (open the details → re-verify):

| state | `verify` layout count |
|---|---|
| `<details>` **closed** (default) | **10** |
| `<details>` **open** (clicked its summary) | **0** |

```
node src/cli.mjs verify --cold -s villas            # details closed → layout=10
node src/cli.mjs click --selector "details.disclose > summary" -s villas
node src/cli.mjs verify -s villas                    # details open → layout=0
```

**Root cause.** A closed `<details>` hides its slotted content through the UA
`::details-content` pseudo-element (`content-visibility: hidden`). That pseudo is **not a node
in the `parentElement` chain**, so the ancestor walk in `layout-audit.mjs` — which is what
routes a `content-visibility:auto` ancestor into the "deferred" bucket (the W1 fix) — finds
`content-visibility: visible` on the element *and every DOM ancestor*, fails to bucket it, and
falls through to the generic `why = 'content-visibility'` invisible warning
(`layout-audit.mjs:137` → `verify.mjs`). Walked live from the flagged SVG:

```
svg.rent-svg               | cv=visible | checkVisibility=false
figure.fig.rent-fig        | cv=visible | checkVisibility=false
details.disclose           | cv=visible | checkVisibility=true   ← detailsOpen:false
section.m-sec.defer.is-open | cv=visible | checkVisibility=true   ← the cv:auto section, already painted
```

So the warning is wrong twice: it says the cause is `content-visibility`, but the computed
`content-visibility` on the element and all DOM ancestors is `visible`; the real cause is the
collapsed `<details>`.

**Fix direction.**
- Give a closed `<details>` the same treatment W1 gave `content-visibility:auto`: detect
  `el.closest('details:not([open])')` and collapse those descendants to **one** info line —
  "N interactive elements in a collapsed `<details>` (…); open to audit" — a sibling of the
  `deferred` bucket. A native accordion is deliberate progressive disclosure; its content
  paints on toggle just as cv:auto paints on scroll.
- More general signature for pseudo-element hides (closed `<details>`, `hidden=until-found`):
  `checkVisibility() === false` while **every DOM ancestor's computed `content-visibility` is
  `visible`**. Don't label those `content-visibility` — the ancestor walk already has the data
  to tell "I could not find the cause in the DOM chain" from "I found a cv:auto ancestor."
- Severity is MEDIUM for the same reason W1/D5 were: 10 per-element lines for one collapsed
  widget re-buries real findings, and native `<details>` (accordions, "show more", the exact
  progressive-disclosure idiom WCII builds every long page from) is everywhere.

## W6 · MAJOR — `screenshot --selector` returns a blank clip once a `<details>` has been opened

`screenshot --selector` silently produces a **blank** image for a genuinely-painted element,
for the rest of the session, once any `<details>` on the page has been opened. Viewport
(clip-less) screenshots are unaffected, so it is easy to trust the blank.

**Minimal repro — no `verify`, no scroll needed (session `villas6`):**

```
node src/cli.mjs screenshot --selector "header"                      # 5002 B — renders fine
node src/cli.mjs click --selector "details.disclose > summary"        # open ANY <details>
node src/cli.mjs screenshot --selector "header"                      # 288 B — BLANK
node src/cli.mjs scroll --to "#rent"
node src/cli.mjs screenshot --selector ".rent-lede"                  # 470 B — BLANK
```

The `header` sits at document y 0–58 and is **not moved** by a `<details>` that expands far
below it, yet its clip goes blank the moment the details opens. So this is **not** a clip-
coordinate error — the clip dimensions are correct (`1280×58`, `1112×154`); only the pixels
are empty. At the blank moment the target is provably painted: the same-scroll **viewport**
screenshot is a healthy 62–75 KB and shows the element, and `eval` reports
`checkVisibility()===true`, a valid in-viewport `getBoundingClientRect`, and the real
`innerText`. It is a **paint failure in the clip path**, not a "nothing there."

**Bisection (7 sessions) — what does NOT cause it:** a fresh session (selector shots 5002 /
2402 B, fine); a single `verify` cold, warm, or `--themes` (fine); a `scroll` (fine); even
`warm verify → scroll → selector shot` (fine). The one factor present in **every** blank
session and absent from **every** clean one is that a `<details>` had been **opened**. It
reproduces with the details toggle alone and nothing else (`villas6`, above).

**Mechanism.** `screenshotAction` (`extras.mjs:150`) force-paints **only** for the full-page
path — `const wantForce = !!body.fullPage && body.forcePaint !== false;` (line 156) — on the
stated assumption that *"a viewport/element capture paints what is actually on screen"* (line
155). Opening a `<details>` triggers Chrome's `content-visibility` / size transition on the
`::details-content` pseudo; while that compositor state is live, `Page.captureScreenshot` with
a **`clip`** (the selector path, line 169/181 — no `captureBeyondViewport`) returns unpainted
pixels, even for regions nowhere near the details. The clip-less viewport capture (`fromSurface`,
no clip) recomposites normally, which is why it survives. The line-155 assumption is the bug:
a post-mutation clip does **not** paint what's on screen.

**Fix direction.**
- Force a fresh main-frame paint before a selector capture — call `forcePaint`/`paintTick`
  unconditionally on the selector path (not just `fullPage`), or issue the clip capture with
  `captureBeyondViewport:true` + `fromSurface:true`, which recomposites the requested region.
- Adjacent latent issue to fix in the same move: the selector path derives its clip from
  `DOM.getBoxModel` (document-absolute coords) but captures with **no** `captureBeyondViewport`
  (viewport-relative). Those agree only at `scrollY≈0`; `captureBeyondViewport:true` fixes the
  paint **and** the coordinate basis together.
- Cheap guardrail regardless: after clipping a `checkVisibility()===true` element, if the webp
  is ~solid-color (bytes below an area-scaled floor), warn "clip may be blank; retried with
  force-paint" instead of silently handing back an empty primary artifact (cf. W2).
- Severity MAJOR: it is a silent, misleading primary observation, and `<details>`/accordion
  toggles are a routine step in exercising a page.

## Re-confirmations — the 2026-07-24 fixes (W1–W4) all landed

Not defects; recorded because they were verified live on a fresh page this round.

- **W1 (content-visibility:auto) — fixed.** The `MobileSection.defer` sections are no longer
  flagged per-descendant; `verify.mjs` collapses them to one "deferred" info line. (The 10
  warnings this round are W5's *closed `<details>`* — a different mechanism, not a W1
  regression.)
- **W2 (`--full` stitches blank over deferred sections) — fixed.** `forcePaint` (`extras.mjs`)
  forces every `content-visibility:auto` subtree to paint for a full-page capture and reports
  `forcedPaint:N`; the help documents it. Viewport shots of the deferred page were correct.
- **W3 (warm reload silently drops cold findings) — fixed.** Every `verify` now labels its load
  state: `settled [COLD load]` vs `settled [WARM load]`, and the warm run emits
  `Measured after a WARM load (…loaded 5× in this session) — first-load CLS and first-request
  failures may be understated`. Exactly the load-state honesty filed. Observed live.
- **W4 (no expected-404 allowlist) — fixed.** `--ignore-404 /path` is present on both `session
  open` and `verify`. Independently, the villas cold verify showed `net(failed=0)` with no
  `/favicon.ico` row at all: WCII added an inline theme-aware SVG favicon (dist markup:
  "Placeholder mark … clears the /favicon.ico 404"), so the 404 is gone at the source too.

---

*Filed by the WCII villas-on-rio copy-cleanup session, 2026-07-25. Repro app state: WCII branch
`home-ux-redesign`, page `/building/villas-on-rio`, built `dist/` served by `astro preview
v5.18.2` on :4332. W5 traces to the `::details-content` pseudo-hide vs the DOM-ancestor walk in
`src/daemon/layout-audit.mjs`; W6 to the fullPage-only force-paint in
`src/daemon/extras.mjs:150` (`screenshotAction`).*
