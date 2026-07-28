# Glassbox research: agent-browser ↔ dev-loop integration, and Windows-specific engineering

Scope: (1) whether an external tool can hook into Vite/Astro/Next's dev-server pipeline instead
of screen-scraping it, and how to survive localhost's quirks; (2) whether a Windows CDP daemon
can be built without the zombie-process and IPC problems that plague every tool in this space.
Research date: July 2026.

## 0. Headline answer

Nothing in the Vite/Astro/Next ecosystem exposes a stable, documented, external-consumer API for
HMR/error events. The HMR WebSocket protocol is real, typed, and inspectable, but it's treated as
an **internal** client↔server channel — connecting a second, non-framework client is a workaround
discovered by trial and error in GitHub discussions, not a supported integration point
([vitejs/vite#14354](https://github.com/vitejs/vite/discussions/14354)). Error overlays are DOM,
not an API — but `open`-mode Shadow DOM with stable CSS-class internals, which CDP's
`Runtime.evaluate` reads through trivially. On Windows, the picture is clearer: Playwright is a
battle-tested reference for launch/kill/IPC/discovery, and its Windows code is plain TypeScript
with no exotic Win32 dependency — `taskkill /pid {pid} /T /F`, nothing more. A second, independent,
already-working reference for Glassbox's exact daemon-lifecycle problem (single-instance
CDP-owning daemon, Windows TCP-loopback IPC) is the user's own `browser-harness` codebase, read
directly for this report — its Windows IPC and daemon-restart code answers several open questions
below with working code, not speculation.

## 1. Vite HMR WebSocket — protocol shape and external subscription

Vite's dev client opens a `WebSocket` to the dev server using the subprotocol string `'vite-hmr'`
(confirmed via the client source and corroborated in
[vitejs/vite#13218](https://github.com/vitejs/vite/issues/13218) discussion threads about proxying
it). The wire payload is a discriminated union defined in
`packages/vite/types/hmrPayload.d.ts` — fetched directly from the vitejs/vite repo for this
report:

- `ConnectedPayload` — `{ type: 'connected' }`, sent on handshake.
- `PingPayload` — keepalive.
- `UpdatePayload` — `{ type: 'update', updates: Update[] }`, where each `Update` carries
  `type: 'js-update' | 'css-update'`, `path`, `acceptedPath`, `timestamp`, plus internal fields
  for circular-import/invalidation tracking.
- `FullReloadPayload` — `{ type: 'full-reload', path? }`.
- `PrunePayload` — `{ type: 'prune', paths: string[] }`.
- `ErrorPayload` — `{ type: 'error', err: { message, stack, id?, frame?, plugin?, pluginCode?,
  loc? } }` — **this is the one Glassbox actually wants**: a structured build/syntax error with
  file:line:col, no HTML scraping required.
- `CustomPayload` — arbitrary plugin-defined events.

Source: [`packages/vite/types/hmrPayload.d.ts`](https://github.com/vitejs/vite/blob/main/packages/vite/types/hmrPayload.d.ts).

On the client side, Vite also dispatches DOM `CustomEvent`s (`vite:beforeUpdate`,
`vite:afterUpdate`, `vite:beforeFullReload`, `vite:error`, `vite:ws:connect`,
`vite:ws:disconnect`) that a page-injected script can listen for
([Vite HMR API docs](https://vite.dev/guide/api-hmr)) — cleaner than raw WebSocket sniffing, but
it only fires inside a page that already has the Vite client loaded (Glassbox would read it via
`Runtime.evaluate`/`Runtime.addBinding` inside the tab CDP already controls, not out-of-band).

**Can an external tool open its own raw WebSocket to the HMR endpoint?** Empirically yes, but
fragile: [vitejs/vite#14354](https://github.com/vitejs/vite/discussions/14354) shows a developer
failing to connect from Postman/an external client because the dev-server port multiplexes HTTP
asset serving and the HMR upgrade by default; the fix was moving `server.hmr.port` to a
**separate** dedicated port. `server.ws.*` (successor to the deprecated `server.hmr.*` transport
options) is the current documented surface ([Vite server-options docs](https://vite.dev/config/server-options)),
but it targets reverse-proxy deployments, not third-party tooling — no message-framing guarantee
across Vite majors, and Vite refuses to forward a `vite-hmr` connection to a different upstream
server, i.e. it actively resists being treated as a generic pub/sub bus.

**Design implication:** treat the HMR socket as a *bonus* fast-path (subscribe when Glassbox can
see it, to get instant "rebuild happened / errored" signal without polling), never as the primary
mechanism — it's project-config-dependent (custom `server.ws.port` breaks blind connection),
version-dependent, and framework-specific (Next.js doesn't use it at all — see §2).

## 2. Error overlays: DOM shape per framework

All three frameworks isolate their dev-error UI in **`open`-mode Shadow DOM**, which matters
enormously for a CDP-based tool: an *open* shadow root is queryable via
`el.shadowRoot.querySelector(...)` from `Runtime.evaluate` — a *closed* one would block this
entirely. None of the three closes it.

- **Vite**: custom element `<vite-error-overlay>`, registered via
  `customElements.define('vite-error-overlay', ErrorOverlay)`, `this.attachShadow({mode:'open'})`
  in the constructor. Internals are addressed by stable class names inside the shadow root:
  `.plugin`, `.message-body`, `.file`, `.frame`, `.stack`. Source:
  [`packages/vite/src/client/overlay.ts`](https://github.com/vitejs/vite/blob/main/packages/vite/src/client/overlay.ts).
  A read recipe: `document.querySelector('vite-error-overlay')?.shadowRoot?.querySelector('.message-body')?.textContent`.
- **Astro**: the dev server *is* Vite under the hood; community reports describe Astro patching
  Vite's overlay module at build time (renaming the internal `ErrorOverlay` class and substituting
  its own) — also why duplicate-registration bugs show up when both try to `customElements.define`
  the same tag ([vitejs/vite#16432](https://github.com/vitejs/vite/issues/16432)). Astro's separate
  **Dev Toolbar** (present on every dev page) has an actual documented plugin API — a `canvas`, an
  `app` interface for client events, a `server` interface for server communication, and
  `toggleNotification({state, level})` for surfacing errors ([Dev Toolbar App API](https://docs.astro.build/en/reference/dev-toolbar-app-reference/),
  [Dev Toolbar guide](https://docs.astro.build/en/guides/dev-toolbar/)) — a legitimate, supported
  extension point Glassbox could ship a toolbar app against, not just a DOM-reading hack.
- **Next.js**: overlay lives inside a `<nextjs-portal>` custom element using `attachShadow()`
  (traced in community writeups to `@next/react-dev-overlay/.../ShadowPortal.js`), to keep dev-UI
  CSS from leaking into the app. Next 15.2+ added "owner stacks" for higher-fidelity component
  stack traces ([Next.js 15.2 blog](https://nextjs.org/blog/next-15-2)), and a clickable Node.js
  icon in the overlay copies a `devtools://` URL for inspecting the *server* process — evidence
  Next expects the overlay to be operated by a human, not scraped.

**Design implication:** a single generic "read the error overlay" routine — find any custom
element whose tag matches `*-overlay|*-portal`, walk into its (open) shadow root, pull text by a
small allowlist of class/role selectors — covers Vite, Astro, and Next with one code path, with
framework-specific selector tables as the only per-framework state. Astro additionally deserves a
first-class toolbar-app integration since it's an actual sanctioned API, not a DOM-reading hack.

## 3. Dev-server auto-discovery

**Port conventions**: Vite defaults to 5173 and *silently increments* (5174, 5175, …) on
conflict unless `strictPort: true` is set
([Vite server-options docs](https://vite.dev/config/server-options)) — meaning "the port in
`package.json`/`vite.config`" is only a hint, not ground truth, at the moment a second project is
already running. This directly kills any discovery strategy that trusts config-file parsing alone.

**The pattern that actually works in the wild — regex the process's own stdout for its
ready-URL** — is exactly what Playwright's own `webServer` config does: a `url` field for
readiness polling *and* a pattern-matching mode that scans stdout/stderr for a regex like
`/Listening on port (?<port>\d+)/`, capturing named groups
([Playwright webServer docs](https://playwright.dev/docs/test-webserver)). Practically every dev
server prints a stable, greppable "Local: http://localhost:PORT/" banner specifically so tools (and
humans) can regex it; there's no cross-framework structured alternative. VS Code's `launch.json`
ships the same idea as a first-class feature (`serverReadyAction`, matching a `pattern` against
debug console output and opening a `uriFormat`-templated URL) — the same design, independently
arrived at ([VS Code debugging docs](https://code.visualstudio.com/docs/editor/debugging)).

**`package.json` script parsing** is a weaker secondary signal: `scripts.dev` commonly encodes an
explicit `--port` flag, but can't tell you whether that port was *actually* bound (vs.
auto-incremented away) without also probing. `detect-port`
([node-modules/detect-port](https://github.com/node-modules/detect-port), 5M+ weekly downloads)
is the standard Node primitive for "is this port free" — useful for Glassbox choosing its *own*
daemon port, less useful for discovering someone else's already-bound dev-server port.

**Design implication:** discovery should be a layered probe, not a single method — (1) if the
launching agent supplies a URL/port explicitly, trust it; (2) else spawn/attach to the dev command
and regex stdout for a `https?://[\w.]+:\d+` banner (steal Playwright's `webServer.url`/pattern
approach directly — it's proven); (3) else fall back to scanning the common default ports (5173,
5174…, 3000, 4321 for Astro, 4200 for Angular) with a real HTTP probe, never a bare TCP connect
(a bare connect can hit an unrelated stale listener — see the browser-harness `ping()` handshake
pattern in §8, which solves the identical false-positive problem for daemon discovery).

## 4. Localhost quirks

**Secure-context special-casing**: per the W3C Secure Contexts spec, `http://localhost` (and
`127.0.0.0/8`, `::1/128`, and now `*.localhost`) is treated as **"potentially trustworthy"** even
over plain HTTP — Chrome and (since Firefox 84) Firefox both implement this
([MDN: Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts),
[W3C Secure Contexts spec](https://www.w3.org/TR/secure-contexts/)). Practical upshot for
Glassbox: **service workers, crypto.subtle, and other secure-context-gated APIs all work on plain
`http://localhost` with zero TLS setup** — a dev server that adds self-signed HTTPS is opting
into a strictly harder problem (cert trust prompts, HSTS pinning) for no capability gain in local
dev. Recommend agents skip HTTPS dev servers when the choice is theirs.

**Self-signed TLS / HSTS**, when a project *does* run HTTPS locally (Next's experimental
`--experimental-https`, Vite's `basicSsl` plugin): browsers cache both the cert-trust decision and
HSTS state aggressively per-origin; a stale cert error can persist until the browser is fully
restarted (`chrome://restart`), and HSTS can force `https://` even after the dev server reverts to
plain HTTP, producing a confusing connection-refused instead of a cert warning
([HSTS-on-localhost writeup](https://weblog.west-wind.com/posts/2022/Oct/24/HSTS-Fix-automatic-rerouting-of-http-to-https-on-localhost-in-Web-Browsers)).
`mkcert` is the standard escape hatch — a local CA installed into the OS/browser trust store so
minted certs carry zero warnings ([FiloSottile/mkcert](https://github.com/FiloSottile/mkcert)).
For a CDP-driven tool the more direct fix is protocol-level: `Security.setIgnoreCertificateErrors(true)`
unconditionally silences cert-trust failures for the session
([CDP Security domain](https://chromedevtools.github.io/devtools-protocol/tot/Security/)) — the
right lever for Glassbox, not asking the user to run `mkcert`.

**Stale service workers / caches**: a known, named class of pain — "service worker held my entire
site hostage" writeups are common
([case study](https://israynotarray.com/en/misc/2023/10/29/service-workers-stale-cache-blog-not-updating/)),
and there's a documented Chromium quirk where `registration.unregister()` silently no-ops when the
scope URL is exactly `localhost`
([xjavascript.com service-worker cache guide](https://www.xjavascript.com/blog/how-to-clear-cache-of-service-worker/)).
CDP gives Glassbox three programmatic levers, cleanest first: `Network.setBypassServiceWorker(true)`
— *"Toggles ignoring of service worker for each request... Bypass service worker and load from
network"* — leaves the registration intact but routes every request around it for the session;
`ServiceWorker.unregister({scopeURL})` for a hard removal; `Network.setCacheDisabled(true)` for the
plain HTTP cache, independent of service workers (from the
[CDP Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/) and
[CDP ServiceWorker domain](https://chromedevtools.github.io/devtools-protocol/tot/ServiceWorker/)).
Chrome's own Workbox docs recommend disabling the service worker entirely during active development
([Workbox: improving the dev experience](https://developer.chrome.com/docs/workbox/improving-development-experience)).

**Design implication:** Glassbox's tab-setup step (before every verification run, not just once)
should default to `Network.setBypassServiceWorker(true)` + `Network.setCacheDisabled(true)`, and
expose `Security.setIgnoreCertificateErrors` as an opt-in flag for projects running self-signed
local HTTPS — this removes an entire category of "why is it showing the old build" false bug
reports without asking the user to touch DevTools.

## 5. Windows child-process lifecycle: why zombie chrome.exe happens

The root cause is structural, not a bug any one tool can fully "fix": Windows has no POSIX
process-group/session concept, so `SIGTERM`/`SIGKILL` to a parent does not propagate to children
by default, and Node's own docs plus ecosystem experience converge on the same failure mode —
child processes spawned without deliberate lifecycle wiring simply keep running when the parent
dies unexpectedly
([Node child_process docs](https://nodejs.org/api/child_process.html),
[orphan-cleanup field notes](https://medium.com/@arunangshudas/5-tips-for-cleaning-orphaned-node-js-processes-196ceaa6d85e)).
Puppeteer's own issue tracker has years of exactly this symptom on Windows —
`browser.close()` racing a `Target closed` protocol error and leaving `chrome.exe` running
([puppeteer#5911](https://github.com/puppeteer/puppeteer/issues/5911),
[puppeteer#1825](https://github.com/puppeteer/puppeteer/issues/1825),
[puppeteer#1367 — Chromium survives a crashed parent](https://github.com/puppeteer/puppeteer/issues/1367)).

**Windows Job Objects** are the theoretically-correct fix: put the launcher in a job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and the kernel guarantees every process ever spawned inside
that job dies the instant the job handle closes — no race, no enumeration needed
([Job Objects for process-tree management](https://nikhilism.com/post/2017/windows-job-objects-process-tree-management/)).
Two caveats explain why almost nothing in this space actually uses them. **Nesting**: a process
can belong to only one job on Windows 7/Server 2008 R2 and earlier; nested jobs require Windows
8+/Server 2012+ ([MS docs: Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)),
and Chrome already puts its own renderer/GPU children into a job object — largely academic by 2026,
but the historical reason tools defaulted to `taskkill`. **No native Node API**: Job Objects are a
Win32 kernel primitive; plain Node `child_process` has no `CreateJobObject`/`AssignProcessToJobObject`
binding, so using one needs a native addon or shelling out — complexity most dev-tool CLIs skip,
reaching for `taskkill /T` instead ([pnpm#12406](https://github.com/pnpm/pnpm/issues/12406) discusses
the same tradeoff for pnpm's script runner; even .NET's `Process.Kill(entireProcessTree: true)` has
an open bug failing silently against a KILL_ON_JOB_CLOSE-protected intermediate process —
[dotnet/runtime#107992](https://github.com/dotnet/runtime/issues/107992)).

**What Playwright actually ships** (read directly from `packages/utils/processLauncher.ts` in the
microsoft/playwright repo): on non-Windows, `spawn(..., {detached: true})` puts the child in its
own process group, killed via `process.kill(-pid, 'SIGKILL')` against the negative PID (the whole
group). **On Windows there is no process-group kill, so Playwright shells out to
`taskkill /pid {pid} /T /F`** — `/T` for the whole descendant tree, `/F` to force — via
`spawnSync`, logging stdout/stderr. No Job Objects, no native addon, no `tree-kill` dependency:
plain `taskkill`. A graceful-first variant (drop `/F`, cooperative shutdown, escalate on timeout)
is tracked in [playwright#18209](https://github.com/microsoft/playwright/issues/18209), which also
notes Playwright's `killAndWait` historically SIGKILLed immediately with no grace period. The
`webServer` docs confirm the platform asymmetry directly: *"Windows doesn't support SIGTERM and
SIGINT signals, so graceful shutdown options are ignored on Windows platforms"*
([Playwright webServer docs](https://playwright.dev/docs/test-webserver)) — on Windows it's
forceful `taskkill` or nothing.

**Design implication:** don't build Job Object plumbing for v1 — copy Playwright's exact recipe
(`taskkill /pid {pid} /T /F` as the hard-kill path, attempted CDP-level graceful close first when
possible) since it's the field-tested baseline every competing tool converges on regardless of
language. Track the *daemon's own* PID plus every Chromium PID it spawned (Glassbox already has
this for free via CDP `Target` events / `Process.pid` on launch) so the kill doesn't rely on tree
discovery at all — an explicit PID list plus `taskkill /T` per top-level PID is cheaper and more
reliable than either job objects or PID-tree enumeration.

## 6. Named pipes vs TCP loopback for local daemon IPC

Named pipes (`\\.\pipe\name`) are the closer Windows analogue to a POSIX Unix-domain socket, and
carry a real advantage: an actual Windows ACL/security-descriptor attachable at creation — a
genuine access-control boundary, not just "whoever's on `127.0.0.1` can connect." **`browser-harness`,
read directly for this report (`src/browser_harness/_ipc.py`), makes a different, pragmatic
choice**: AF_UNIX + `chmod 0600` on POSIX, but plain **TCP loopback on an OS-assigned ephemeral
port (`bind(('127.0.0.1', 0))`) plus a 32-byte random bearer token on Windows** — deliberately
*not* named pipes. The code comment explains why: *"TCP loopback has no chmod-equivalent so any
local process could otherwise issue CDP commands"* — the same access-control gap this report
flags, closed with an application-level token instead of named-pipe ACLs (likely because
security-descriptor plumbing via `ctypes` is meaningfully more code than "generate a token, require
it on every request" for the same guarantee against a same-box unprivileged process). The daemon
writes `{port, token}` as JSON to an atomically-renamed `.port` file (`write → os.replace`), and
every request after the handshake must carry that token.

The generic Node performance argument for named pipes/Unix sockets over TCP loopback — no TCP
handshake, no IP-stack traversal, lower syscall count — is well established (a commonly cited
benchmark reports roughly 130µs for a Unix-socket round trip vs ~334µs over TCP loopback; treat
the exact numbers as indicative, not load-bearing, but several sources agree on the *direction*:
[Node.js `net` docs](https://nodejs.org/api/net.html) describe `net.createServer` supporting IPC
via Windows named pipes explicitly, and [nodevibe: Unix Domain Sockets](https://nodevibe.substack.com/p/the-nodejs-developers-guide-to-unix)
lays out the mechanism). Named pipes on Windows aren't free of surprises either — there's an open
Node.js issue reporting elevated CPU specifically under Windows named-pipe IPC load
([nodejs/node#51968](https://github.com/nodejs/node/issues/51968)), one more point in favor of
`browser-harness`'s simpler TCP-loopback-plus-token choice for a tool whose request volume is "a
few dozen CDP calls per verification run," not a hot path.

**Design implication:** copy `browser-harness`'s exact pattern rather than reaching for named
pipes: TCP loopback (`127.0.0.1`, ephemeral port via `bind(..., 0)`) on Windows, Unix domain
socket + `chmod 0600` on POSIX, a random bearer token required on every Windows request, and an
atomically-written `{port, token}` JSON file as the discovery handle. It's less code than named
pipes, sidesteps the reported CPU issue, and the security gap (any local process *could* still
port-scan and brute-force-guess, in theory) is adequately closed by a 256-bit token for a
localhost dev tool's threat model.

## 7. Windows Defender / firewall prompts and loopback binding

The firewall-prompt trigger is specifically **binding to a non-loopback interface** — `0.0.0.0`/`::`
(all interfaces) is what makes Windows Firewall treat a listener as network-reachable and worth an
inbound-rule decision; a pure `127.0.0.1`/`::1` bind never puts traffic on a real NIC, so it doesn't
cross the firewall's filtering point and doesn't trigger the "blocked some features of this app"
dialog. When a prompt *does* fire, the practical fix is Control Panel → "Allow an app through
Windows Firewall" → confirm the runtime is checked for Private networks — but the correct
engineering fix is upstream: never bind wider than loopback for a tool with no legitimate LAN use
case (consensus practitioner guidance across the sources surveyed, not a single pinned formal spec).
`browser-harness` binding `127.0.0.1` specifically for its Windows TCP fallback (§6) is the correct
instance of this pattern already shipping.

**Design implication:** Glassbox's daemon must never default to `0.0.0.0`. Loopback-only bind is
both the security-correct and the annoyance-avoiding choice, with zero functionality cost for a
tool whose only client is agent code running on the same machine.

## 8. Windows long-path issues

Node's own `node_modules` nesting strategy is, per a live Node.js issue, "basically incompatible"
with the historical Windows 260-character `MAX_PATH` limit, especially in deeply nested installs
([nodejs/node#50753](https://github.com/nodejs/node/issues/50753)). Windows 10 1607+ supports paths
beyond `MAX_PATH` via the registry key `LongPathsEnabled`, but it ships **off by default**, and
Node.js is reported to *not* fully honor it even when the OS-level switch is flipped
([nodejs/node#50753](https://github.com/nodejs/node/issues/50753);
background: [MS docs: Maximum File Path Limitation](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation)).
Git's `core.longpaths true` is a related, separately-scoped workaround (the `\\?\` extended-path
prefix internally) that does not fix Node's own fs calls.

**Design implication**: keep the daemon's own runtime state (socket/port files, PID files,
per-session artifacts) under a short, top-level path (`%LOCALAPPDATA%\glassbox\` or
`%TEMP%\glassbox\`, never nested inside a deep project checkout) — exactly the pattern
`browser-harness` uses (`_ipc.py`'s `_TMP`/`_RUNTIME` resolve to `tempfile.gettempdir()` on
Windows, not a path derived from the working directory; the same code comment notes AF_UNIX's
104-byte `sun_path` limit on macOS forces identical short-path discipline there). The failure mode
to design against isn't Glassbox's own paths — it's a *target project's* `node_modules` tripping
`ENAMETOOLONG` when Glassbox's own file/screenshot logic walks into it; catch
`ENAMETOOLONG`/`EINVAL` distinctly rather than as a generic I/O error.

## 9. Daemon lifecycle patterns: single-instance lock, PID files vs port probes

The naive versions of both are individually broken: a bare PID file can point at a PID **reused**
by an unrelated process after a crash (Windows and Linux both recycle PIDs); a bare port-probe
(`can I connect to 127.0.0.1:PORT`) can succeed against an unrelated process that grabbed the same
ephemeral port after the daemon died. General pidfile-locking libraries acknowledge exactly this —
staleness has to be actively verified, not assumed ([trbs/pid](https://github.com/trbs/pid),
[dkorolev/pidlock](https://github.com/dkorolev/pidlock)).

**`browser-harness`'s `ensure_daemon()`/`restart_daemon()` (read directly for this report,
`admin.py` + `_ipc.py`) is a working, already-shipping solution to this exact problem, worth
copying near-verbatim:**

1. **Liveness is a handshake, not a connect.** `ping()` opens the socket/port and requires the
   peer to answer `{"pong": true}` to a `{"meta": "ping"}` request — a bare successful TCP connect
   is explicitly *not* trusted, because a stale `.port` file plus port reuse after a crash would
   otherwise make an unrelated process look alive.
2. **Liveness isn't enough — depth-probe the thing you actually care about.** `ensure_daemon()`
   doesn't stop at "daemon answers ping"; it issues a real CDP call (`Target.getTargets`) and only
   treats the daemon as usable if that succeeds, because a daemon process can be alive-but-useless
   (its CDP connection to Chrome died) while still answering pings. On failure it self-heals via
   `restart_daemon()` and respawns.
3. **PID-reuse-safe kill**: before signaling, `restart_daemon()` re-verifies identity two
   independent ways — the daemon's self-reported PID from a fresh `identify()` handshake still
   matches, or a process-start-time fingerprint taken earlier is unchanged. On Windows that
   fingerprint comes from `ctypes` calling `GetProcessTimes` for the process-creation `FILETIME`
   via `kernel32.OpenProcess`/`GetProcessTimes`/`CloseHandle` — a working, dependency-free Win32
   call from Python, specifically because a different start-time after a reused PID means "not my
   process, don't touch it." If identity doesn't re-verify, it just cleans up stale lock files and
   gives up quietly instead of signaling.
4. **Single-instance enforcement is implicit in the discovery mechanism**, not a separate lock
   file: `ensure_daemon()` does the ping+depth-probe above and only spawns a new process if that
   fails — the atomically-written port/pid files *are* the lock, checked by liveness-probe rather
   than by existence.
5. **The Windows spawn-flag choice matters and is non-obvious**: `spawn_kwargs()` uses
   `CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`, with a comment that `DETACHED_PROCESS` was tried
   and rejected — per Win32 docs it *overrides* `CREATE_NO_WINDOW`, so the "obvious" detach flag
   actually makes Windows allocate a fresh, visible console for the still-console-subsystem Python
   interpreter. The two flags actually listed are what achieves a silent, Ctrl-C-isolated
   background process.

This is a second, independent worked example (distinct from Playwright's kill strategy) of the
same lesson: **on Windows, identity verification has to be re-derived from the OS at the moment of
action, never trusted from a previously-written file.** Graceful crash recovery here is just "the
next `ensure_daemon()` call self-heals" — no separate crash-handler path; a robust
discovery+depth-probe function makes one unnecessary.

## 10. Design implications for Glassbox (rollup)

- **HMR/error-overlay integration is opportunistic, not load-bearing.** Read `ErrorPayload` when
  the framework's own WebSocket is reachable (fast path), but primary error-detection must be
  CDP-level (`Runtime.exceptionThrown`, console errors, DOM-read of the open-shadow-root overlay)
  — HMR-socket reachability is one `vite.config` edit away from silently breaking.
- **One generic overlay-reader, framework-selector-tabled.** Vite/Astro/Next all park dev UI in
  `open` Shadow DOM — one "find `*-overlay|*-portal` custom element → walk its open shadow root →
  pull by selector" routine covers all three; only the selector table is per-framework. Give Astro
  a second, first-class path via its documented Dev Toolbar API.
- **Dev-server discovery = layered probe, not config parsing.** Explicit URL from the caller first;
  else regex launch-command stdout for a `http://host:port` banner (Playwright's `webServer`
  approach, proven); else scan known default ports with a real HTTP probe, never a bare connect
  (§9's PID/port-reuse lesson applies equally here).
- **Default every tab-setup step to `Network.setBypassServiceWorker(true)` +
  `Network.setCacheDisabled(true)`**, `Security.setIgnoreCertificateErrors` opt-in for self-signed
  local HTTPS — kills an entire class of "stale build" false reports for free.
- **Windows process kill = Playwright's recipe, not Job Objects.** Track PIDs explicitly at spawn
  time (free via CDP), hard-kill via `taskkill /pid {pid} /T /F` per top-level PID, graceful
  CDP-level close attempted first when there's budget. Skip Job Objects for v1 — no native
  Node/Python binding without extra dependencies, and every mainstream competitor ships
  `taskkill`-only instead.
- **IPC = TCP loopback + bearer token on Windows, AF_UNIX + `chmod 0600` on POSIX** —
  `browser-harness`'s already-working design; skip named pipes, which cost more Win32 plumbing for
  a security property a random token already delivers at this threat model, and have an open
  Node.js CPU-usage report against them under load.
- **Daemon liveness = depth-probe, never a bare connect or PID-file existence check.** Handshake
  for "is anything answering," then a real functional call for "is CDP→Chrome actually alive,"
  self-healing on either failure — collapses "crash recovery" into "the next call already handles
  it," no separate recovery path needed.
- **Always bind loopback-only (`127.0.0.1`), never `0.0.0.0`** — avoids the Firewall prompt
  entirely rather than requiring a user click-through.
- **Keep Glassbox's own runtime files in a short top-level path** (`%TEMP%\glassbox\` /
  `%LOCALAPPDATA%\glassbox\`), independent of the target project's directory depth, and treat
  `ENAMETOOLONG`/`EINVAL` distinctly wherever Glassbox touches paths inside an arbitrary target
  project.

## Sources

- [Vite HMR API docs](https://vite.dev/guide/api-hmr)
- [Vite server-options docs](https://vite.dev/config/server-options)
- [vitejs/vite discussion #14354 — connecting an external client to the HMR websocket](https://github.com/vitejs/vite/discussions/14354)
- [vitejs/vite issue #16432 — duplicate ErrorOverlay custom-element registration](https://github.com/vitejs/vite/issues/16432)
- [vitejs/vite issue #13218](https://github.com/vitejs/vite/issues/13218)
- [vitejs/vite `packages/vite/types/hmrPayload.d.ts` (source)](https://github.com/vitejs/vite/blob/main/packages/vite/types/hmrPayload.d.ts)
- [vitejs/vite `packages/vite/src/client/overlay.ts` (source)](https://github.com/vitejs/vite/blob/main/packages/vite/src/client/overlay.ts)
- [Astro Dev Toolbar App API reference](https://docs.astro.build/en/reference/dev-toolbar-app-reference/)
- [Astro Dev Toolbar guide](https://docs.astro.build/en/guides/dev-toolbar/)
- [Next.js 15.2 blog (owner stacks in the dev overlay)](https://nextjs.org/blog/next-15-2)
- [Node.js `net` module docs](https://nodejs.org/api/net.html)
- [nodejs/node issue #50753 — long node_modules paths fail with LongPathsEnabled](https://github.com/nodejs/node/issues/50753)
- [nodejs/node issue #51968 — high CPU with Windows named pipes](https://github.com/nodejs/node/issues/51968)
- [MS docs: Maximum File Path Limitation](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation)
- [MS docs: Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)
- [Windows Job Objects for process-tree management (Nikhil's blog)](https://nikhilism.com/post/2017/windows-job-objects-process-tree-management/)
- [dotnet/runtime issue #107992 — Process.Kill(entireProcessTree) fails under JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE](https://github.com/dotnet/runtime/issues/107992)
- [pnpm issue #12406 — Windows process-tree kill via taskkill /T /F](https://github.com/pnpm/pnpm/issues/12406)
- [microsoft/playwright `packages/utils/processLauncher.ts` (source)](https://github.com/microsoft/playwright/blob/main/packages/utils/processLauncher.ts)
- [microsoft/playwright issue #18209 — webserver kill should try SIGTERM before SIGKILL](https://github.com/microsoft/playwright/issues/18209)
- [Playwright `webServer` test-config docs](https://playwright.dev/docs/test-webserver)
- [puppeteer/puppeteer issue #5911 — chrome.exe not killed on Windows](https://github.com/puppeteer/puppeteer/issues/5911)
- [puppeteer/puppeteer issue #1825 — zombie process problem](https://github.com/puppeteer/puppeteer/issues/1825)
- [puppeteer/puppeteer issue #1367 — Chromium survives a crashed parent Node process](https://github.com/puppeteer/puppeteer/issues/1367)
- [ChromeDevTools/chrome-devtools-mcp (README/repo)](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [ChromeDevTools/chrome-devtools-mcp issue #889 — hardcoded Chrome path discovery breaks on non-standard installs](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/889)
- [ChromeDevTools/chrome-devtools-mcp issue #2309 — Windows stuck-key bug after MCP usage](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2309)
- [Chrome DevTools Protocol — Security domain](https://chromedevtools.github.io/devtools-protocol/tot/Security/)
- [Chrome DevTools Protocol — Network domain (setBypassServiceWorker, setCacheDisabled)](https://chromedevtools.github.io/devtools-protocol/tot/Network/)
- [Chrome DevTools Protocol — ServiceWorker domain](https://chromedevtools.github.io/devtools-protocol/tot/ServiceWorker/)
- [MDN: Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
- [W3C Secure Contexts spec](https://www.w3.org/TR/secure-contexts/)
- [HSTS-on-localhost fix writeup](https://weblog.west-wind.com/posts/2022/Oct/24/HSTS-Fix-automatic-rerouting-of-http-to-https-on-localhost-in-Web-Browsers)
- [FiloSottile/mkcert](https://github.com/FiloSottile/mkcert)
- [Service-worker stale-cache case study](https://israynotarray.com/en/misc/2023/10/29/service-workers-stale-cache-blog-not-updating/)
- [xjavascript.com — clearing service-worker cache, localhost unregister() quirk](https://www.xjavascript.com/blog/how-to-clear-cache-of-service-worker/)
- [Chrome for Developers — Workbox: improving the dev experience](https://developer.chrome.com/docs/workbox/improving-development-experience)
- [node-modules/detect-port](https://github.com/node-modules/detect-port)
- [VS Code debugging docs (serverReadyAction)](https://code.visualstudio.com/docs/editor/debugging)
- [nodevibe — Node.js Unix domain sockets vs TCP loopback latency](https://nodevibe.substack.com/p/the-nodejs-developers-guide-to-unix)
- [trbs/pid — pidfile with stale detection](https://github.com/trbs/pid)
- [dkorolev/pidlock](https://github.com/dkorolev/pidlock)
- [Orphaned Node.js process cleanup field notes](https://medium.com/@arunangshudas/5-tips-for-cleaning-orphaned-node-js-processes-196ceaa6d85e)

### Internal reference (a private prior-art codebase, not a public literature source)

- `browser-harness/_ipc.py` — Windows TCP-loopback + bearer-token IPC; POSIX AF_UNIX +
  `chmod 0600`; atomic port-file write; spawn flags.
- `browser-harness/admin.py` — `ensure_daemon()` / `restart_daemon()`: handshake liveness,
  CDP depth-probe, PID-reuse-safe kill via `GetProcessTimes` fingerprinting on Windows.
