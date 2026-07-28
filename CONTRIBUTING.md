# Contributing to Glassbox

Issues and PRs are welcome. This file is short on purpose; the two documents that actually matter
are `docs/00-first-principles.md` (why the tool is shaped the way it is) and `docs/01-architecture.md`
(the decisions, with evidence). Read the first one before proposing an architectural change.

## The most useful contributions right now

In order:

1. **Get macOS working.** Not merely untested — *known broken*. The "POSIX" process reaper reads
   `/proc`, which macOS does not have, so it is inert there (`docs/macos-audit.md`, issue #1). The
   fixes need a BSD `ps` implementation behind a third platform branch, and nobody here has a Mac
   to verify against. Note the failure mode is the one this project exists to prevent: the suite
   goes *mostly green* on a Mac because ~20 "no strays" assertions pass vacuously against an empty
   process list. A confirmed-red report is more useful than a green one.
2. **A UI defect Glassbox misses, as a minimal HTML repro.** This is worth more than a feature.
   See "Bug zoo" below.
3. **CI.** Wiring the suite into GitHub Actions with a cached Chromium.

## Setup

```bash
git clone https://github.com/adihebbalae/glassbox && cd glassbox
npm install
npx playwright install chromium
node src/cli.mjs doctor      # what this machine will and won't let Glassbox measure
```

Node 22+. No build step — it is plain ESM, and what you read is what runs.

## Tests

```bash
npm test              # everything, against a real browser (~17 min)
npm run test:m3       # or any single milestone
```

Every proof drives the real CLI and daemon against a real Chromium, and every one ends by
asserting that `kill-all` leaves zero orphan processes. There are no mocks — a mocked browser
cannot tell you that a default headless launch measures a 0px scrollbar (and a real one is what
eventually told us *why*: Playwright's `--hide-scrollbars`, not the renderer; see §11.1 of
`docs/01-architecture.md`).

Three consequences worth knowing before you write a test here:

- **A fixture must be sensitive to the failure it claims to cover.** This is the one that cost us
  most. The overflow assertion passed for months against a 3000px element, which overflows by
  ~2200px whether or not a scrollbar gutter exists — so it went green in a configuration that could
  not see `100vw` overflow at all, which is the case anyone actually hits. Green against an
  insensitive fixture is not coverage. When you add a check, ask what would have to break for it to
  fail, and then make that happen on purpose.

- **Never assert after a fixed sleep.** The suite spawns daemons, browsers, MCP shims and dev
  servers; under full-suite load anything you guessed a duration for will eventually race. Poll for
  the real condition with a deadline instead. (This is not hypothetical — a fixed 300ms wait for an
  MCP shim's exit raced under load and cascaded into a second failure.)
- **Each check should be independent of the previous one's cleanup.** If check B needs a clean
  slate, make one; don't inherit it from check A's teardown.

## Bug zoo

`test/bugzoo/` is a seeded-bug site: 18 deliberate defect classes, plus a deliberately **clean**
page as the false-positive check, plus every page seeded from a real field defect.

Note that two of the eighteen are the *same* finding class by different mechanisms —
`layout.html`'s 3000px element and `overflow-vw.html`'s `100vw` child are both horizontal overflow,
and only the second is sensitive to the scrollbar gutter. That pair is deliberate and it is the
template for the point above: when a class has a subtle mechanism and a gross one, seed both, or
your matrix will report coverage you do not have.

To add a case:

1. Add a minimal HTML page under `test/bugzoo/` that exhibits exactly one defect.
2. Add a check asserting Glassbox finds it — and, where it matters, that it does **not** flag the
   clean page for the same reason.
3. If you are fixing a defect the tool got wrong in the field, the test must **fail against the
   pre-fix commit**. That is the standard the existing `test/m9`–`m13` regressions are held to;
   state in the PR which commit you verified it fails on.

## Filing a defect against Glassbox itself

These are the highest-value issues. `docs/defects-*.md` is the existing series and the format to
follow:

- What you ran, exactly, and what it returned.
- What was actually true of the page.
- Whether it is a **false positive** (flagged something that wasn't a defect) or a **false
  negative** (missed something real). False negatives on a verification tool are the serious ones.
- The conditions: platform, headed or headless, cold or warm load. A finding without its conditions
  is a claim the instrument cannot support — that applies to bug reports too.

## PR expectations

- One concern per PR.
- Match the surrounding code: plain ESM, no build step, no new runtime dependencies without a
  discussion first. The single runtime dependency is Playwright and that is deliberate.
- If you change behaviour, change the test that pins it, and say so.
- Comments explain *why*, not *what*. The existing code is written that way; please keep it.

## License

By contributing you agree your contributions are licensed under the MIT License (see `LICENSE`).
The vendored `vendor/axe.min.js` is MPL-2.0 and must not be modified in place — see
`THIRD-PARTY-NOTICES.md`.
