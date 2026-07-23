# Vendored third-party assets

Files here are checked in on purpose (they ship with Glassbox) even though their
source packages are dev-only. Regenerate with the commands below.

## axe-core

- **File**: `axe.min.js`
- **Version**: 4.12.1
- **License**: MPL-2.0 (Deque Systems)
- **Source**: `node_modules/axe-core/axe.min.js` (installed via `npm i -D axe-core`)
- **Used by**: `src/daemon/verify.mjs` — injected on demand (only when `verify` runs
  with `axe:true`) via `page.evaluate(<file contents>)`, then `axe.run()` is invoked
  scoped to the verification target. axe-core is a **devDependency**; this vendored
  copy is what actually runs at runtime so end users need not install it.

Regenerate:

```
npm i -D axe-core
cp node_modules/axe-core/axe.min.js vendor/axe.min.js
# then bump the Version line above to match node_modules/axe-core/package.json
```
