# macOS (darwin) compatibility audit — Glassbox v0.1.0

**Date:** 2026-07-28
**Method:** static source audit. No macOS execution. See §0.
**Verdict:** macOS does **not** "take the same POSIX path Linux does." The POSIX path is a
`/proc` filesystem reader, and macOS has no `/proc` at all. The platform seam claims a
win32-vs-posix split; the real split is **win32 / linux / darwin**, and darwin is currently
routed into a Linux-only implementation that fails closed-but-silent.

The README (`README.md:157`) and `CONTRIBUTING.md:11` both state macOS "very likely works"
because it shares the POSIX path. **That claim is false and should be corrected.** It is not a
question of untested-but-probably-fine; four subsystems are provably inert on darwin.

---

## 0. Why this audit is static

Checked what is on this box:

| Tool | Present | Relevant |
|---|---|---|
| Docker 29.2.1 | yes (WSL2 backend, `docker-desktop` stopped) | **no** |
| WSL 2 | yes | no — Linux only |
| QEMU | no | — |
| VirtualBox | no | — |

Docker cannot run macOS. Containers share the host kernel, and macOS binaries need the XNU/Darwin
kernel plus its userland frameworks — there is no Darwin base image, and Apple's SLA restricts
macOS virtualization to Apple-branded hardware. Darling (the Darwin translation layer) runs *on*
Linux and is incomplete — no working Chromium, no Cocoa. No macOS image was downloaded or run.

Conclusion: running the suite on macOS here is infeasible. Everything below is source-traced.
§8 states honestly what genuinely requires a real Mac.

---

## 1. BREAKS — `/proc` does not exist on macOS

### F1. The entire POSIX process reaper is inert on darwin  🔴 BREAKS

`src/daemon/prockit.mjs:16`

```js
const impl = process.platform === 'win32' ? win32 : posix;
```

A two-way dispatch. darwin silently receives the Linux implementation.

`src/daemon/prockit-posix.mjs:15` — `const PROC = '/proc';`

`src/daemon/prockit-posix.mjs:1` — the header comment reads *"the Linux/macOS twin of
prockit-win32.mjs"*. It is not a macOS twin. **The documentation asserts support the code does
not deliver**, which is how this survived review.

Function-by-function on darwin:

| Function | Line | Behaviour on macOS | Severity |
|---|---|---|---|
| `commandLineFor(pid)` | 18–24 | `readFileSync('/proc/<pid>/cmdline')` → ENOENT → returns `''` **always** | 🔴 BREAKS |
| `verifyGlassboxPid(pid)` | 27–33 | derives from `commandLineFor` → `''.includes(...)` → **always `false`** | 🔴 BREAKS |
| `processAlive(pid)` | 42–50 | `process.kill(pid,0)` works; `isZombie` always returns `false` | 🟠 degraded |
| `isZombie(pid)` | 52–59 | reads `/proc/<pid>/stat` → throws → `false` ("assume alive") | 🟠 degraded |
| `pids()` | 62–68 | `readdirSync('/proc')` → ENOENT → returns `[]` **always** | 🔴 BREAKS |
| `ppidOf(pid)` | 71–80 | → `0` always | 🔴 BREAKS |
| `taskkillTree(pid)` | 89–115 | tree collapses to `[target]`; see F9 | 🟠 partial |
| `scan(match)` | 118–125 | iterates `pids()` = `[]` → `[]` | 🔴 BREAKS |
| `listGlassboxChromium()` | 132–138 | **`[]` always** | 🔴 BREAKS |
| `listGlassboxDaemons()` | 146–150 | **`[]` always** | 🔴 BREAKS |
| `sweepOrphans()` | 153–159 | returns `0`, kills nothing | 🔴 BREAKS |

This is exactly the failure the file's own header (`prockit-posix.mjs:5–10`) was written to
prevent, reintroduced one platform over:

> *"A counter that says 'clean' when it means 'I could not look' is the one thing an orphan
> check must never do."*

On macOS every orphan check says **clean** and means **I could not look**.

`processAlive` is the one survivor: `process.kill(pid, 0)` is POSIX and correct on darwin. It
loses only zombie detection — and macOS reparents orphans to `launchd`, which reaps them, so the
zombie window the Linux code defends against is much narrower there. Acceptable to degrade.

#### The fix — a third implementation, `prockit-darwin.mjs`

Split the seam three ways at `prockit.mjs:16`:

```js
const impl = process.platform === 'win32' ? win32
           : process.platform === 'darwin' ? darwin
           : linux;   // rename prockit-posix.mjs → prockit-linux.mjs; it IS Linux-only
```

Renaming the file is part of the fix, not cosmetics: `posix` is the name that caused this.

Implementation notes, with the BSD-vs-GNU `ps` traps that matter:

- **Enumeration (replaces `pids()` + `ppidOf()` + `scan()`):** one pass —
  `ps -Ao pid=,ppid=,command= -ww`
  - Use **`-A`, not `-e`.** In classic BSD syntax `-e` means *show the environment*. macOS aliases
    `-e` to `-A` in POSIX form, but `-A` is unambiguous on both and cannot be misread.
  - **`-ww` is mandatory, not optional.** macOS `ps` truncates the command column. The reaper
    matches on `--user-data-dir=<long absolute path>`, which sits late in a chromium command line
    that runs to several hundred characters. Without `-ww` the marker is silently cut off and you
    rebuild the *exact* "reports zero, means I could not look" bug — this time with a subprocess
    that appears to have worked.
  - `-o key=` with the trailing `=` suppresses the header on BSD as it does on GNU.
- **`commandLineFor(pid)`:** `ps -p <pid> -o command= -ww`.
  - `command` is the BSD keyword; `args` is its documented alias. GNU's `cmd` is **not** portable —
    do not use it.
  - **Do not use `comm=`.** `ps -p <pid> -o comm=` returns only the executable path with **no
    arguments**, so the `--user-data-dir` marker is absent and every match fails. (`comm=` is the
    obvious-looking choice and is wrong for this use.)
- **`ppidOf(pid)`:** take the `ppid=` column from the same single pass. `pgrep -P <pid>` exists on
  macOS for direct children if a targeted query is preferred, but one `ps` pass is cheaper than N.
- **`processAlive(pid)`:** keep `process.kill(pid, 0)` — already correct. For the zombie check,
  `ps -p <pid> -o stat=` and test for a leading `Z`. `kill -0` / `process.kill(pid,0)` succeeds on
  a zombie on darwin exactly as on Linux.
- **Same-user constraint:** macOS restricts reading another user's process arguments
  (`KERN_PROCARGS2` is privileged); `ps -o command=` for another user's process yields just the
  executable name. Glassbox's daemons and chromiums are same-uid, so this is fine — but the
  fallback must not read a truncated line as "not ours" and then **refuse to kill**, which would
  resurrect the same class of silent no-op.
- **Group kill:** keep the backstop but gate it — see F9.

---

### F2. `kill-all` cannot force-kill a wedged daemon on macOS, then orphans it permanently  🔴 BREAKS

`src/cli.mjs:186`

```js
if (daemonPid && processAlive(daemonPid) && verifyGlassboxPid(daemonPid)) taskkillTree(daemonPid);
```

`verifyGlassboxPid` is **always `false`** on darwin (F1), so the force-kill **never executes**.

The `--force` recovery path has the same guard and is equally dead:

`src/cli.mjs:196` — `if (verifyGlassboxPid(pid) && taskkillTree(pid)) daemonStrays.push(pid);`
(and `listGlassboxDaemons()` at `cli.mjs:194` returns `[]` anyway, so the loop never iterates).

Then, unconditionally:

`src/cli.mjs:213–217` — `fs.unlinkSync(PATHS.daemonFile)`

**Full failure sequence on macOS.** A daemon stops answering `/shutdown` (the graceful path,
`cli.mjs:182–183`, is the only one that still works). `kill-all` cannot signal it, deletes
`daemon.json`, and reports success. The daemon is now alive, holding a Chromium, and **invisible
to every future run** — no discovery file names it and `listGlassboxDaemons()` cannot find it.
Every subsequent `precondition clean` check passes vacuously while the machine accumulates
browsers. Only a manual `kill -9` recovers.

This is precisely the scenario `cli.mjs:187–191` documents as the reason the `--force` path exists.
On macOS both the primary and the recovery path are inoperative.

Related: `src/daemon/daemon.mjs:205` — the startup `sweepOrphans()` that reaps a crashed
predecessor's chromium returns `0` and kills nothing.

**Fix:** F1 fixes this. No change needed at these call sites.

---

### F3. `--headed` silently launches HEADLESS on macOS  🔴 BREAKS

`src/platform.mjs:186–190`

```js
export function ensureDisplay(headed) {
  if (!headed || IS_WIN32) return { display: headed ? 'headed' : 'headless' };
  if (process.env.DISPLAY && !XVFB) return { display: 'headed', server: process.env.DISPLAY };
  if (XVFB) return { display: 'headed-xvfb', server: process.env.DISPLAY };
  if (!hasXvfb()) return { display: 'headless', downgraded: 'headed requested but no Xvfb and no DISPLAY' };
```

Trace on darwin with `headed = true`:

1. `:187` — not win32, `headed` is true → falls through.
2. `:188` — macOS has no `DISPLAY` (no X11 unless XQuartz is installed) → falls through.
3. `:189` — `XVFB` is null → falls through.
4. `:190` — `hasXvfb()` shells `which Xvfb` (`platform.mjs:174`), which fails on macOS → **returns
   `{ display: 'headless' }`**.

The premise is wrong for darwin. macOS runs headed Chromium **natively** on WindowServer. It needs
no X server, and Xvfb has no macOS equivalent because none is required. The code treats "no X
server" as "no display possible," which is true on Linux and false on macOS.

The downgrade then propagates into the actual launch:

`src/daemon/sessions.mjs:86–87`

```js
displayInfo = ensureDisplay(headed);
const launchOpts = launchOptions({ headed: displayInfo.display !== 'headless' });
```

→ `launchOptions({ headed: false })` → `platform.mjs:215` `{ headless: true }`.

Two further consequences beyond the wrong mode:

- `sessions.mjs:76` — the persistent-context cache key is still `'headed'` while the launched
  browser is headless. The `headed` and `headless` slots now hold indistinguishable browsers, and
  the first `--headed` request poisons the `headed` slot for the daemon's whole lifetime.
- `sessions.mjs:182` — `rec.headed` stays `true`, disagreeing with reality.
- `sessions.mjs:323` — `display: s?.headed ? displayInfo.display : 'headless'` resolves to
  `'headless'`, so the conditions block is *honest*, but the `downgraded` reason string is
  **dropped** — it is never copied into the returned object. The user asked for headed, got
  headless, and receives no explanation anywhere.

**Fix:** exclude darwin from the X11 branch entirely at `platform.mjs:187`.

```js
if (!headed || IS_WIN32 || process.platform === 'darwin') {
  return { display: headed ? 'headed' : 'headless' };
}
```

darwin headed is native and needs no display provisioning — identical to the win32 case.

---

### F4. `sweepDevOrphans()` never reaps a dev server on macOS, and deletes the evidence  🔴 BREAKS

`src/dev.mjs:107`

```js
if (rec && rec.pid && rec.cmdline && commandLineFor(rec.pid) === rec.cmdline) {
  killTree(rec.pid);
```

Fails on darwin in both directions:

- Record written on macOS: `rec.cmdline` was captured via `commandLineFor()` → `''` → falsy →
  **the `&& rec.cmdline` guard short-circuits** and the kill never runs.
- Record written elsewhere: `commandLineFor(rec.pid)` returns `''` ≠ `rec.cmdline` → false.

Then `src/dev.mjs:111` — `fs.unlinkSync(p)` — runs regardless, **deleting the record**.

So on macOS the orphaned dev server is not killed, and the only record of its existence is
destroyed. Its port stays bound forever. The next run reports "your dev server is already
running" with nothing to point at. `kill-all` prints `dev orphans reaped 0`, truthfully counting
zero and falsely implying there were none.

`processAlive(rec.cliPid)` at `dev.mjs:106` works correctly on darwin, so the ownership check is
sound — only the cmdline re-verification is broken.

**Fix:** F1 fixes this. No change needed at this call site.

---

## 2. LIKELY BREAKS

### F5. Chromium discovery finds nothing on macOS  🟠 LIKELY BREAKS

`src/platform.mjs:121`

```js
const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', '/ms-playwright'].filter(Boolean);
```

Both hardcoded roots are Linux-container paths. The darwin default is missing. Confirmed from the
installed `playwright-core` (`lib/coreBundle.js`, `defaultCacheDirectory`):

```js
if (process.platform === "darwin")
  return path.join(os.homedir(), "Library", "Caches");
// → registryDirectory = ~/Library/Caches/ms-playwright
```

`src/platform.mjs:131`

```js
for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-linux/headless_shell']) {
```

All three are Linux-only. Playwright 1.61's actual darwin layout (`coreBundle.js:28177–28189`,
`EXECUTABLE_PATHS`):

| Build | macOS relative path |
|---|---|
| chromium arm64 | `chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` |
| chromium x64 | `chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` |
| headless shell arm64 | `chrome-headless-shell-mac-arm64/chrome-headless-shell` |
| headless shell x64 | `chrome-headless-shell-mac-x64/chrome-headless-shell` |

Note it is **`Google Chrome for Testing.app`**, not `Chromium.app` — Playwright moved to
Chrome-for-Testing builds. The bundle path contains **spaces**, which any hand-built command
string must quote (`execFileSync` with an argv array is safe; a `shell:true` string is not).

`src/platform.mjs:141`

```js
for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
```

macOS ships browsers as `.app` bundles under `/Applications`, not as binaries on `PATH`. All four
`which` lookups fail on a stock Mac.

**Directory-name regex is fine.** `platform.mjs:127` `/^chromium(_headless_shell)?-(\d+)$/`
correctly matches the on-disk names — Playwright builds them as
`name.replace(/-/g,'_') + '-' + revision` → `chromium-1228`, `chromium_headless_shell-1228`.
Only the roots and the relative paths are wrong.

**Net effect:** `findChromium()` returns `{ path: null }`. `launchOptions()` at
`platform.mjs:222–224` then falls back to `opts.channel = 'chromium'`, which **should still work**
if `npx playwright install chromium` has been run, because Playwright's own registry does know
`~/Library/Caches/ms-playwright`. So the product likely still launches a browser — via a fallback
path, with three visible consequences:

1. `src/cli.mjs:570–574` (message at `:572`) — `glassbox doctor` **always** prints *"No chromium found on disk. Set
   GLASSBOX_CHROMIUM=/path/to/chrome…"* on macOS, even when everything works. The first diagnostic
   a Mac user runs gives a false alarm.
2. `test/m13.mjs:62–63` — asserts `!!c.path` for any non-win32 `KIND`. **Hard test failure on
   macOS.** See §6.
3. `describePlatform().browserPath` (`platform.mjs:307`) reports `'playwright channel:chromium'`
   rather than a real path, so verify reports cannot name the binary they measured with.

**Fix:** make both lists platform-aware.

```js
const roots = [
  process.env.PLAYWRIGHT_BROWSERS_PATH,
  process.platform === 'darwin' && path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  process.platform === 'linux'  && path.join(os.homedir(), '.cache', 'ms-playwright'),
  '/opt/pw-browsers', '/ms-playwright',
].filter(Boolean);

const RELS = process.platform === 'darwin'
  ? ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
     'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
     'chrome-headless-shell-mac-arm64/chrome-headless-shell',
     'chrome-headless-shell-mac-x64/chrome-headless-shell']
  : ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-linux/headless_shell'];
```

And extend the PATH fallback (`platform.mjs:141`) with the macOS bundle locations:
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
`/Applications/Chromium.app/Contents/MacOS/Chromium`.

---

### F6. A Mac with `PLAYWRIGHT_BROWSERS_PATH` set is misclassified as a **sandbox**  🟠 LIKELY BREAKS

`src/platform.mjs:52`

```js
if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) why.push('no DISPLAY');
```

`src/platform.mjs:54`

```js
return why.length >= 2 ? { kind: 'sandbox', why } : { kind: 'posix', ... };
```

"No DISPLAY" is strong evidence of a headless Linux container. On macOS it is **the normal state
of every Mac ever made** — there is no X11 unless XQuartz is installed. So darwin starts with one
free sandbox point, and needs only one more to tip.

`platform.mjs:47` supplies it: `PLAYWRIGHT_BROWSERS_PATH` is a common developer setting (and
`PLAYWRIGHT_BROWSERS_PATH=0`, the "keep browsers in node_modules" idiom, is a **truthy string**
and counts). A plain MacBook with that env var is classified `sandbox`.

Consequences — all of them corrupt the report, which is the product's entire value:

| Site | Wrong behaviour on a misclassified Mac |
|---|---|
| `platform.mjs:291` | `HUMAN_CHANNEL = 'export'` — the live watch URL is disabled though loopback works fine |
| `platform.mjs:309` | `raster: 'software'` — **a false claim in every verify report's conditions block** on a GPU-backed Mac |
| `sessions.mjs:198–200` | timezone force-pinned to `America/Los_Angeles`, locale to `en-US`, silently overriding the user's real settings |
| `sessions.mjs:332` | reports that fabricated timezone as measured fact |
| `platform.mjs:168` | `defaultHeaded()` now enters the sandbox branch; returns false anyway via `hasXvfb()`, so no additional harm |

A verification tool that misstates its own measurement conditions is worse than one that declines
to measure. This finding is lower-severity than F1–F4 only because it needs an env var to trigger.

**Fix:** the `no DISPLAY` heuristic must not apply on darwin.

```js
if (process.platform !== 'darwin'
    && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) why.push('no DISPLAY');
```

Better still, return early for darwin before the heuristic block, mirroring the win32 early return
at `platform.mjs:43` — a Mac is a local workstation unless `GLASSBOX_PLATFORM=sandbox` says
otherwise. Container-on-Mac is always Linux-in-a-VM and reports `process.platform === 'linux'`, so
there is no case this early return would wrongly capture.

---

## 3. RISKY

### F7. macOS overlay scrollbars may make headed mode no better than headless  🟡 RISKY

`platform.mjs:156–166` and `sessions.mjs:176–181` both rest the entire headed-mode rationale on
one measurement:

> *"headless Chromium reports a scrollbar width of 0px (overlay scrollbars), headed-under-Xvfb
> reports 15px — the same reserved gutter Windows Chrome gives you. A 0px scrollbar silently hides
> the entire `100vw`-horizontal-overflow and right-edge-clipping bug class, which is exactly what a
> layout audit exists to catch."*

> **Correction, 2026-07-28 — the quoted rationale above states the wrong cause.** The 0px headless
> measurement is not Chromium overlay scrollbars. It is `--hide-scrollbars`, which Playwright
> appends to *every* headless launch unconditionally (`playwright-core` `coreBundle.js:42539`,
> `:42744`). Measured on Windows 11, 800×600, a page with a `100vw` child:
> `headless defaults → 0px`, `headless + ignoreDefaultArgs: ['--hide-scrollbars'] → 15px`,
> `headed → 15px`. The quotation is preserved as-written because it is what the source files said
> at audit time; the source files themselves are now corrected. See §11.1 of `01-architecture.md`.

**F7 survives the correction, and gets sharper.** The finding was never really about headless — it
is about whether *this platform reserves a gutter at all*. macOS uses **overlay scrollbars
natively**, headed or not: the system default under *Settings → Appearance → Show scroll bars* is
"Automatically based on mouse or trackpad", which gives overlay (0px reserved) on any trackpad Mac.
That is a genuinely different mechanism from the Playwright flag, and it is **not fixable by
removing the flag**. So the 15px gutter may not exist on macOS in *any* configuration.

If confirmed, the `100vw`-overflow and right-edge-clipping bug class — a headline capability — is
undetectable on a default Mac regardless of flags. That is a *product* limitation on macOS, not a
crash, and it needs a real measurement (§8.2) before any fix is designed. The honest interim move
is for the conditions block to state the measured scrollbar width rather than implying the Windows
gutter.

Note the practical ordering this creates: on Windows and Linux the fix is one launch option; on
macOS it may require synthesising the gutter (e.g. forcing a classic scrollbar via a CDP
`Emulation` override or a stylesheet) or accepting a documented `portability` downgrade on that
finding class. Do not ship a macOS fix that reports 15px without measuring one.

### F8. Blind process-group kill  🟡 RISKY

`prockit-posix.mjs:113`

```js
try { process.kill(-target, 'SIGKILL'); killedAny = true; } catch { /* not a group leader */ }
```

Runs unconditionally, after a tree walk that on darwin found nothing (F1). If `target` is not a
group leader but some **unrelated** process group happens to have that gid, this SIGKILLs a
stranger's entire process group. Low probability, high blast radius. On Linux the walk normally
kills the real tree first, so the blind shot rarely matters; on darwin it is the *only* thing that
fires, on every call.

This also contradicts the project's own stated rule — *"we never kill a PID without first
confirming its command line is ours"* (`prockit-win32.mjs:2–4`). A negative-PID kill confirms
nothing.

**Fix:** gate it on the target actually being a group leader —
`ps -p <pid> -o pgid=` equals `pid` — before signalling the group.

### F9. `taskkillTree` reports success after a partial kill  🟡 RISKY

`prockit-posix.mjs:110–114` sets `killedAny = true` after killing the single target. On darwin the
tree is always `[target]` alone, so a non-group-leader PID (a Chromium helper, a renderer) is
killed while its own children survive — and the function still returns `true`. Callers, including
`dev.mjs:82` `killTree()` and `cli.mjs:186`, read that as a completed tree kill.

**Fix:** F1. Once enumeration works the tree is real again.

### F10. Linux-shaped launch flags and shell-outs on the darwin path  🟡 RISKY

- `platform.mjs:228` — `--disable-dev-shm-usage` is pushed for **all** non-win32 platforms. macOS
  has no `/dev/shm`. Chromium ignores the switch, so this is harmless, but it is Linux
  configuration leaking into darwin and should be gated on `process.platform === 'linux'`.
- `platform.mjs:201` — `execFileSync('sleep', ['0.1'])` as a busy-wait. Modern macOS `sleep`
  accepts fractional seconds, so this works — but it sits on the Xvfb path darwin should never
  enter once F3 is fixed. Low priority; a `setTimeout`-free spin via `Atomics.wait` would be the
  portable form if it is ever needed.
- `platform.mjs:143, 174` — `which` exists on macOS. Fine.
- `platform.mjs:230` — `process.getuid() === 0` → `--no-sandbox`. Correct and rarely triggered on
  macOS. Fine.

---

## 4. FINE — verified, no action needed

- **`cli.mjs:230–232`** — `openBrowser()` has a correct explicit darwin branch
  (`spawn('open', [url])`). This is the one place in the codebase where darwin is handled properly,
  which shows the gap elsewhere is oversight rather than policy.
- **`stateRoot()` — `platform.mjs:79–92`** — darwin resolves to `~/.glassbox`. Absolute, writable,
  consistent across CLI/daemon/tests. Not the `~/Library/Application Support` platform convention,
  but correctness beats convention here and changing it would be a migration. Leave it.
- **Detached spawn — `protocol.mjs:166`** — `{ detached: true }` on POSIX creates a new process
  group (setsid). Correct on darwin, and it is what makes the group-kill backstop viable at all.
- **Signals — `daemon.mjs:255–256`, `dev.mjs:211`** — SIGINT/SIGTERM/SIGHUP all behave correctly on
  darwin. `SIGBREAK` (`dev.mjs:211`) is Windows-only; on POSIX Node registers it as an inert
  listener that never fires. Already proven harmless by the green Linux run.
- **Port binding — `daemon.mjs:233`** — `server.listen(0, '127.0.0.1')`. Ephemeral loopback port,
  no privileged bind, no UNIX socket. Portable.
- **Single-instance — `daemon.mjs:4–5`** — enforced by the discovery file plus a ping/probe
  liveness handshake, deliberately **not** a lock file. No `flock`/`fcntl` divergence between
  platforms to worry about. Good design for portability.
- **Path handling** — every path is built with `path.join`. The only backslash manipulation is
  `cli.mjs:266–268` (`unmangleMsysPath`), correctly gated on
  `process.platform !== 'win32' || !process.env.MSYSTEM` → returns unchanged on darwin.
- **Case sensitivity** — audited every relative import specifier in `src/` and `test/` against the
  on-disk filenames. All lowercase, **zero mismatches**, and **no two files differ only by case**.
  macOS's case-insensitive APFS will not mask a failure that Linux CI would catch. Clean.
- **`package.json`** — `engines.node >= 22` (fine on macOS), one runtime dep (`playwright`), one
  dev dep (`axe-core`). **No `postinstall`, no optional deps, no `os`/`cpu` fields.** Nothing to
  fix. Note `npm test` runs 13 modules sequentially via `&&` — portable shell operator.
- **`test/fixtures/third-party.mjs:47–51`** — already fixed to use `pathToFileURL`, correct on all
  three platforms. **I checked for the inverse bug class** (win32-only main-module guards,
  hand-built `file://` strings, `import.meta.url` compared against a raw path) across `src/` and
  `test/`: **no other occurrences**. This one was the only instance.
- **`shell: true` — `dev.mjs:153`** — Node uses `/bin/sh` on darwin, same as Linux. zsh is the
  macOS *interactive* default but is irrelevant to `child_process`. No BSD-vs-GNU exposure here:
  the codebase shells out only to `which`, `sleep`, `Xvfb`, `open`, and `npm` — it never invokes
  `sed`, `grep`, or `awk`, so the usual GNU/BSD flag divergences do not apply.

---

## 5. Every `process.platform` / platform-string branch, and what darwin does

| Site | Branch | darwin result |
|---|---|---|
| `prockit.mjs:16` | `=== 'win32' ? win32 : posix` | **posix (Linux impl) — F1** 🔴 |
| `platform.mjs:41` | `=== 'win32' ? 'win32' : 'posix'` | `posix` (only when `GLASSBOX_PLATFORM` forced) |
| `platform.mjs:43` | `=== 'win32'` early return | falls through to heuristics |
| `platform.mjs:52` | `!DISPLAY && !WAYLAND_DISPLAY` | **pushes a false sandbox point — F6** 🟠 |
| `platform.mjs:54` | `why.length >= 2 → sandbox` | **misclassifies with one more signal — F6** 🟠 |
| `platform.mjs:81` | `IS_WIN32` state root | posix branch → `~/.glassbox` ✅ |
| `platform.mjs:152` | `IS_WIN32 ? channel : findChromium()` | **`findChromium()` → null — F5** 🟠 |
| `platform.mjs:168` | `!IS_SANDBOX → false` | headless default, same as Windows ✅ |
| `platform.mjs:187` | `!headed \|\| IS_WIN32` | **falls into the X11 path — F3** 🔴 |
| `platform.mjs:217` | `IS_WIN32 → channel` | posix branch → executablePath or channel fallback |
| `platform.mjs:228` | non-win32 → `--disable-dev-shm-usage` | harmless no-op — F10 🟡 |
| `platform.mjs:230` | `getuid() === 0` | correct, rarely hit ✅ |
| `platform.mjs:291` | `IS_SANDBOX ? 'export' : 'live'` | wrong if F6 triggers 🟠 |
| `platform.mjs:309` | `IS_SANDBOX ? 'software' : 'gpu'` | wrong if F6 triggers 🟠 |
| `cli.mjs:230` | `=== 'win32'` | falls to `:231` |
| `cli.mjs:231` | `=== 'darwin'` → `open` | **correct** ✅ |
| `cli.mjs:266` | `!== 'win32' \|\| !MSYSTEM` | returns unchanged ✅ |
| `cli.mjs:570` | `!chrome.path && KIND !== 'win32'` | **false doctor warning — F5** 🟠 |
| `dev.mjs:157` | `!== 'win32'` → detached | correct: own process group ✅ |
| `sessions.mjs:198` | `IS_SANDBOX` tz/locale pin | wrong if F6 triggers 🟠 |
| `sessions.mjs:332` | `IS_SANDBOX` tz report | wrong if F6 triggers 🟠 |
| `m13.mjs:61` | `KIND !== 'win32'` | **asserts a Linux-only fact — §6** 🟠 |

No `os.platform()` calls exist; the codebase consistently uses `process.platform`. No `darwin`
string comparison exists anywhere except `cli.mjs:231`.

---

## 6. Test harness on macOS

### Hard failures (three, all real product bugs surfacing correctly)

| Check | Location | Why |
|---|---|---|
| `1d chromium resolved by PATH` | `test/m13.mjs:61–63` | asserts `!!findChromium().path` for any non-win32 `KIND`; darwin returns null (F5) |
| `7a the process reaper can see our chromium` | `test/m13.mjs:180–182` | asserts `listGlassboxChromium().length > 0` with a browser live; darwin returns `[]` (F1) |
| `e1 kill-all reaps an orphaned dev server` | `test/m7.mjs:199–201` | the record's `cmdline` is captured at `m7.mjs:186` via `commandLineFor()` → `''` on darwin, so `dev.mjs:107`'s re-verification never passes and `devOrphans` stays 0 (F1, F4) |

Check `7a` is the suite working exactly as designed — it was added in M13 precisely to stop the
orphan checks passing vacuously, and on macOS it is the one thing that fails loudly enough to
reveal F1. Good instrument.

### Vacuous passes — the more dangerous category

Every `precondition clean` and `zero strays` assertion passes on macOS **because
`listGlassboxChromium()` returns `[]`**, not because the machine is clean. Roughly 20 call sites:

`m1.mjs:44,93,97` · `m2.mjs:66,137,140` · `m3.mjs:43,124,127` · `m4.mjs:45,159,162` ·
`m5.mjs:84,185,188` · `m6.mjs:83` · `m10.mjs:66,203,206` · `m11.mjs:65,175,178` ·
`m12.mjs:77,135,195,198` · `live-devserver.mjs:158,162`

A Mac user will therefore see a **mostly-green suite with three failures**, and the green is not
trustworthy. The three failures are the honest signal; the ~20 passes are noise. Any macOS bug
report should be read with that in mind — which is why the issue template in
`launch/issue-01-macos.md` asks for the full output rather than a pass/fail summary.

### Harness-only concerns (not product bugs)

- `test/live-devserver.mjs:98` — `spawnSync('npm', ['install'], { shell: true })` with a 15-minute
  timeout. Fine on macOS. Not part of `npm test`.
- Every test spawns via `process.execPath` with argv arrays — no shell quoting exposure.
- `test/m13.mjs:107` — `os.tmpdir()` for the HAR fixture. Portable.
- No test depends on `/proc`, GNU coreutils, or a specific shell.

---

## 7. Ranked fix list

| # | Finding | Severity | Fix size |
|---|---|---|---|
| 1 | F1 — `prockit-darwin.mjs` + 3-way seam; rename `prockit-posix` → `prockit-linux` | 🔴 BREAKS | new file (~120 lines) + 1-line dispatch |
| 2 | F3 — darwin skips the Xvfb path in `ensureDisplay` | 🔴 BREAKS | 1 line |
| 3 | F6 — `no DISPLAY` is not sandbox evidence on darwin | 🟠 LIKELY | 1–4 lines |
| 4 | F5 — darwin roots + `.app` bundle relative paths in `findChromium` | 🟠 LIKELY | ~12 lines |
| 5 | F8/F9 — gate the group kill on real group leadership | 🟡 RISKY | folded into #1 |
| 6 | F10 — gate `--disable-dev-shm-usage` on linux | 🟡 RISKY | 1 line |
| 7 | F7 — measure macOS scrollbar width; state it in conditions | 🟡 RISKY | needs a Mac first |
| 8 | Docs — correct the "same POSIX path as Linux" claim | 🟠 | `README.md:157`, `CONTRIBUTING.md:11`, `prockit-posix.mjs:1` |

F2 and F4 need no code of their own — they are call sites that become correct once F1 lands.

---

## 8. What I could not determine statically

Honest list. These need a real Mac.

1. **Whether `channel: 'chromium'` actually launches on macOS.** After F5, this fallback
   (`platform.mjs:224`) is what the entire product depends on for finding a browser there. Playwright's
   own registry should resolve it after `npx playwright install chromium`, but "should" is doing
   real work in that sentence and it is the single most load-bearing unknown.
2. **The real headed scrollbar width on macOS (F7).** Determines whether the horizontal-overflow
   bug class is detectable on a Mac at all. One `window.innerWidth - document.documentElement.clientWidth`
   in a headed session answers it. Cannot be reasoned out — it depends on the user's
   *Show scroll bars* setting and whether a mouse is attached.
3. **Gatekeeper / quarantine on first Chromium launch.** A Playwright-downloaded, unsigned-for-this-machine
   `.app` may be quarantined (`com.apple.quarantine` xattr) and refuse to launch, or prompt. Playwright
   normally handles this, but under `executablePath` (F5's fix) the bundle is launched directly,
   which may behave differently.
4. **TCC permission prompts.** `screencast.mjs` drives `Page.startScreencast` over CDP, which is
   in-process and should not trip macOS Screen Recording permission — but "should not" is unverified,
   and a blocking TCC dialog in a daemon with `stdio: 'ignore'` would hang invisibly.
5. **Whether `ps -ww` is genuinely untruncated** for a real Chromium command line on macOS. I am
   confident enough to specify it, but the exact truncation behaviour when stdout is a pipe rather
   than a tty is worth confirming empirically before trusting the reaper.
6. **Apple Silicon vs Intel.** Which of `chrome-mac-arm64` / `chrome-mac-x64` Playwright installs,
   and whether an arm64 Node spawning an x64 Chromium under Rosetta 2 introduces launch latency
   that blows the 15s daemon budget (`protocol.mjs:167`) or the 5s Xvfb budget.
7. **Timing budgets generally.** First-launch Gatekeeper verification of a ~200MB app bundle can
   take many seconds. `protocol.mjs:167`'s 15s `ensureDaemon` cap and the various test timeouts were
   calibrated on Windows and Linux.
8. **Font-metric and screenshot assertions in m8/m9/m10.** macOS font rendering, default system
   fonts, and subpixel behaviour differ from both Windows and Linux. Text-metric findings and any
   pixel-comparison thresholds may drift in ways that are impossible to predict from source.
9. **Whether `~/.glassbox` collides with anything** in a real macOS home directory, and whether
   macOS's per-user `TMPDIR` (a long `/var/folders/...` path) interacts badly with the
   `os.tmpdir()` fallback at `platform.mjs:91` — that path is long, and `--user-data-dir` under it
   could approach socket-path length limits.
