# Third-party notices

Glassbox itself is MIT-licensed (see `LICENSE`). It ships or depends on the following
third-party components, which keep their own licenses.

## axe-core — vendored, MPL-2.0

- **File in this repo**: `vendor/axe.min.js`
- **Version**: 4.12.1
- **Copyright**: © 2015–2026 Deque Systems, Inc.
- **License**: Mozilla Public License 2.0 — <https://mozilla.org/MPL/2.0/>
- **Source Code Form**: <https://github.com/dequelabs/axe-core/tree/v4.12.1>
  (the exact file: `axe.min.js` in the published `axe-core@4.12.1` npm package)

`vendor/axe.min.js` is an **unmodified** copy, redistributed verbatim with its copyright
header intact. It is checked in — rather than pulled from `node_modules` at runtime — so
that end users get accessibility checks without installing a devDependency, and so that
Glassbox works inside sandboxes with no npm egress. Glassbox does not link axe-core into
its own source: it is injected into the page under test on demand by
`src/daemon/verify.mjs` and invoked via `axe.run()`.

MPL-2.0 is a **file-level** copyleft. It covers `vendor/axe.min.js` and any modifications
to that file; it does not extend to the rest of Glassbox. If you modify the vendored file,
you must release your modified version of *that file* under MPL-2.0.

To regenerate the vendored copy, see `vendor/README.md`.

## playwright — runtime dependency, Apache-2.0

- **Package**: `playwright` (^1.61.1), © Microsoft Corporation
- **License**: Apache License 2.0 — <https://www.apache.org/licenses/LICENSE-2.0>
- Installed from npm; not vendored. Playwright in turn downloads Chromium, which carries
  its own licenses (BSD-3-Clause and others) — see
  <https://chromium.googlesource.com/chromium/src/+/main/LICENSE>.

## axe-core — devDependency

`axe-core` is also listed under `devDependencies` purely so `vendor/axe.min.js` can be
regenerated from a pinned version. Same MPL-2.0 terms as above.
