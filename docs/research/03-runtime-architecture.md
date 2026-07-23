# Runtime/Shell Architecture Options for a Purpose-Built Local Agent Browser (Windows) — July 2026

## 0. Headline finding: this has already been built, by Microsoft, in the open

Before comparing engines, the single most important fact this research turned up: **Microsoft ships `@playwright/cli` (`microsoft/playwright-cli`)**, a standalone CLI companion to Playwright MCP, launched in early 2026, explicitly targeted at coding agents (Claude Code, GitHub Copilot). Its architecture is almost a point-for-point match to Glassbox's hypotheses:

- **Per-session daemon**: invoking the CLI spawns a detached Node process running `cliDaemon.js` that owns one Playwright `BrowserContext`. The daemon writes a `<session>.session` config file (socket path, browser info, version) and listens on a Unix domain socket — **a named pipe on Windows**.
- **Named parallel sessions**: `-s=name` selects/creates an isolated session; `PLAYWRIGHT_CLI_SESSION` env var pins an agent to one. Sessions are scoped by hashing the project directory (looking for a `.playwright` folder), so multiple repos don't collide.
- **CLI + MCP over one implementation**: "Playwright CLI and Playwright MCP are two transports over one implementation" — both wrap the same `BrowserBackend`/`browserTools` registry (zod-schema'd commands).
- **CDP escape hatch, both directions**: `--cdp=chrome` attaches to an already-running Chrome/Edge by channel name; `--cdp=<url>` connects to an arbitrary CDP endpoint; `detach` leaves the external browser alive on disconnect.
- **One-call verification surface**: `console`, `requests`/`request <n>`, `route` (mocking), `screenshot` (`--hires` for DPR), `snapshot` (YAML a11y-ish tree with stable refs like `e21`, plus `--boxes` for bounding boxes, `--depth=N`), `tracing-start/stop`, `video-start/stop`, cookie/localStorage inspection.
- **Human ride-along**: `playwright-cli show` opens a dashboard — a session grid with **live screencast previews**, session name/URL/title; clicking a session zooms into a live view with tab bar, nav controls, and full remote control; **click into the viewport to take mouse/keyboard control, Escape to release**.
- **Cleanup**: `close-all` (graceful), `kill-all` (greps the process table, sends SIGKILL — an explicit admission that graceful teardown isn't 100% reliable even for the vendor).

What it explicitly does **not** have, per its own docs and third-party analysis: accessibility-tree-as-a-first-class-object (its snapshot is close but not full a11y semantics), coverage analysis, or breakpoint/step debugging. It is optimized for **token-efficient agent driving**, not **white-box UI debugging** — which is exactly Glassbox's stated differentiator. This reframes the research question from "should we use Playwright" to "we should build on the same primitives Microsoft validated, and out-debug them on the axis they left alone." [testdino.com/blog/playwright-cli](https://testdino.com/blog/playwright-cli), [playwright.dev/docs/getting-started-cli](https://playwright.dev/docs/getting-started-cli), [github.com/microsoft/playwright-cli](https://github.com/microsoft/playwright-cli), [tester.army analysis](https://tester.army/blog/inside-playwright-cli-browser-automation-for-coding-agents)

---

## A. Playwright library managing bundled Chromium

**Lifecycle & contexts.** Playwright's model: `BrowserType.launch()` → `Browser` → N `BrowserContext`s → N `Page`s. A context is Playwright's isolation unit — its own cookies/localStorage/sessionStorage/IndexedDB/cache/service-workers, "behaves as if it were two incognito windows." Contexts are cheap to create relative to launching a new browser process; documentation and practitioner guides converge on "use contexts, not separate browsers, for parallelism." [playwright.dev/docs/browser-contexts](https://playwright.dev/docs/browser-contexts), [qaskills.sh context guide](https://qaskills.sh/blog/playwright-browser-contexts-isolation-guide)

**CDPSession escape hatch.** Playwright exposes `page.context().newCDPSession(page)` returning a `CDPSession` for raw protocol access — Chromium-only. Docs frame it explicitly as an escape hatch for "low-level access ... intercepting network traffic at the protocol level, accessing performance metrics, or controlling features not exposed through Playwright's high-level API." [playwright.dev/docs/api/class-cdpsession](https://playwright.dev/docs/api/class-cdpsession)

**`connectOverCDP` — attach instead of launch.** Playwright can skip its own launcher entirely and attach to an already-running Chromium via `browserType.connectOverCDP(wsOrHttpUrl)`, exposing `browser.contexts()[0]` etc. The docs explicitly warn this path has **"significantly lower fidelity than the Playwright protocol connection"** and recommend it only for basic cases — Firefox/WebKit unsupported, and the extent to which video/HAR/trace recording survive over a bare-CDP attach is not spelled out (implication: don't count on parity). This matters for Glassbox because it's the seam where "use Playwright" and "roll our own CDP client" stop being mutually exclusive — you can launch with `chrome-launcher` and drive with Playwright's ergonomics via this call, or vice versa. [playwright.dev connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)

**What the abstraction costs you.** Two costs, one shrinking:
1. *Bundled-binary lag/mismatch.* Historically Playwright compiled Chromium from source at a pinned revision — reproducible, but the binary differed subtly from real Chrome (no proprietary codecs, different default flags) and the version number didn't map to a public Chrome version. **As of Playwright 1.57 (2026), Playwright switched most Chromium-channel runs to Google's own Chrome for Testing (CfT) builds**, closing most of that gap — "you are now running a browser that behaves far more like the Chrome your users actually have." [qaskills.sh CfT vs Chromium](https://qaskills.sh/blog/chrome-for-testing-vs-chromium-playwright)
2. *Protocol laundering.* Playwright's high-level API (`click`, `fill`, `waitForSelector`) is not raw CDP — it's Playwright's own actionability/auto-wait logic layered on top, occasionally issuing several CDP calls per logical action. For a tool whose job is *faithfully reporting what the browser did* (console/network/a11y verification), that's mostly fine since CDPSession still gives raw access when needed; but it means "Playwright says the click happened" and "the browser dispatched a click event" are not quite the same claim, and bugs in Playwright's auto-wait heuristics become bugs in your verification tool.

**Windows process cleanup.** Not independently re-derived for Playwright in sources found, but Playwright inherited its process-management lineage from the same author pool as Puppeteer (Google/Microsoft Chrome DevTools alumni) and Puppeteer's approach is documented in depth (see §Windows cleanup below) — expect the same taskkill-tree pattern. Playwright 1.59 added JS explicit resource management (`await using`) for browsers/contexts/pages, giving **deterministic cleanup on scope exit** even on exceptions — a real improvement over manual try/finally. [qaskills.sh await-using guide](https://qaskills.sh/blog/playwright-await-using-automatic-cleanup-guide)

Known rough edges in the wild: `microsoft/playwright-mcp` issue #1458 ("headed Chrome process running, zombie in app switcher" after CLI close) and #1568 ("headless Chrome processes orphaned after MCP stdio transport closes") — both filed in 2026, both showing that even Microsoft's own tooling on top of Playwright still leaks processes under some exit paths. [github.com/microsoft/playwright-mcp/issues/1458](https://github.com/microsoft/playwright-mcp/issues/1458), [.../issues/1568](https://github.com/microsoft/playwright-mcp/issues/1568)

---

## B. Raw Chromium/Chrome + pure CDP client

**Launching:** `chrome-launcher` (Google Chrome team) — locates a Chrome binary, opens `--remote-debugging-port` on a free port, uses a fresh profile per launch (cleaned up after), binds Ctrl-C by default, exposes `.launch()` (returns `{port, pid, process}`), `.kill()`, and `killAll()`. It explicitly does *not* speak CDP itself — "interacting with the browser must be done over the devtools protocol, typically via chrome-remote-interface." No documented Windows-specific tree-kill logic in its README. [github.com/GoogleChrome/chrome-launcher](https://github.com/GoogleChrome/chrome-launcher/blob/main/README.md)

**Client:** `chrome-remote-interface` (cyrus-and) — a thin 1:1 CDP binding: HTTP GET to `/json` for targets → protocol descriptor (local or fetched) → open a `WebSocket` on the target's `webSocketDebuggerUrl` → JSON-RPC over that socket, `EventEmitter` for notifications. Simple, "should work with every application implementing CDP" (i.e., not Chrome-specific — works against Node's inspector protocol too, and against Electron's debugger transport). [github.com/cyrus-and/chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface)

**Is a zero-dep CDP client viable in Node 24?** Yes, and more viable than at any prior point:
- **Native `WebSocket` client is stable (no flag) in Node 24** — "WebSocket support is now built into Node.js and marked as stable... aligns with the browser standard." Node 24 additionally added `WebSocketStream`. This removes the one real reason to depend on `ws` for a CDP client (per-message-deflate compression isn't needed for local loopback CDP traffic). [nodejs.org v24.0.0 blog](https://nodejs.org/en/blog/release/v24.0.0), [logrocket Node 24](https://blog.logrocket.com/node-js-24-new/)
- **Native `fetch`** (stable since Node 18, unremarkable by 24) covers the `/json/version` and `/json/new` HTTP endpoints CDP launch discovery needs.
- The remaining "library" surface — JSON-RPC id/response correlation, event demux by `sessionId` for `Target.attachToTarget`/flat sessions, and reconnect/backoff — is maybe 150–250 lines and is exactly what `chrome-remote-interface` and `chromiumoxide` both implement from scratch anyway. A hand-rolled client is a legitimate, small, auditable dependency-surface reduction, **provided you also hand-roll the process launcher** (chrome-launcher-equivalent: find binary, pick port, spawn, own the process tree, clean up on Windows — see §Windows below, this is the part worth *not* reinventing).
- Trade-off: you inherit **zero** of Puppeteer/Playwright's target auto-attach handling (new tabs, popups, OOPIF/iframe targets each need their own CDP session and the flat-session-id protocol variant), zero of their input-dispatch-with-visual-verification correctness work, and zero of their multi-year fuzzing against real-world CDP quirks (crashed targets, detached frames mid-command, navigation races). Every one of those is a rediscovered bug.

**Verdict on B in isolation:** viable as a *transport*, risky as a *complete substitute* for Playwright's target-lifecycle and input-dispatch layers. The sane middle path (see Recommendation) is: Playwright for launch/context/target lifecycle + input dispatch, raw CDPSession/native-WebSocket for anything Playwright doesn't expose (Debugger domain, Profiler coverage, CSS cascade).

---

## C. Electron shell

**BrowserView → WebContentsView.** `BrowserView` is deprecated; `WebContentsView` (a `View` wrapping a `WebContents`) is the current API for embedding a controllable web surface inside a window — i.e., the natural per-session tile for a human ride-along dashboard rendered *natively* rather than via screencast-in-a-canvas. [electronjs.org/docs/latest/api/web-contents-view](https://www.electronjs.org/docs/latest/api/web-contents-view)

**`webContents.debugger`.** Electron's built-in CDP transport: `debugger.attach([protocolVersion])` binds a CDP session to a specific `webContents` **without a separate WebSocket** — commands go via `debugger.sendCommand(method, params, sessionId)`, events via the `'message'` listener, teardown via `'detach'`. It's not exported from the `electron` module standalone (only reachable off a `webContents` instance), and multi-target sessions are handled via the `sessionId` parameter (from `Target.attachToTarget`) rather than separate sockets. [electronjs.org/docs/latest/api/debugger](https://www.electronjs.org/docs/latest/api/debugger)

Known sharp edges, straight from Electron's own issue tracker (not fixed as of the versions cited, and CDP auto-attach bugs of this shape tend to resurface across Chromium bumps):
- **#27768**: using CDP's `Fetch` domain via `webContents.debugger` with auto-attached targets stopped working in Electron 11.x and **caused a crash in 12.x**. [github.com/electron/electron/issues/27768](https://github.com/electron/electron/issues/27768)
- **#35318**: `Target.attachedToTarget` isn't emitted when the first navigation is delayed (Electron 14+) — i.e., auto-attach target discovery, the exact mechanism a multi-tab/multi-frame verification bundle needs, has had reliability bugs.
- **#23035**: `debugger.attach('1.1')` blocks some requests outright.

**Chromium version lag / update burden.** Contrary to the folk wisdom that Electron trails Chromium by months, in 2026 Electron intentionally tracks **every other Chromium stable** on an 8-week cadence synced to Chromium's 4-week cadence — "each Electron stable should happen on the same day as Chrome stable," with the Chromium bump usually landing "within one or two weeks" after upstream. So the lag is bounded (~1–8 weeks depending on where in the cycle you ship) rather than open-ended, but it is a **real, permanent second release train you don't control** — a security-critical Chromium CVE lands on Electron's schedule, not Chrome's. [electronjs.org/docs/latest/tutorial/electron-timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines), [releases.electronjs.org/schedule](https://releases.electronjs.org/schedule)

**Size/update burden, qualitatively.** An Electron app ships an entire Chromium + Node runtime per install (historically 150–250MB installed); every Electron minor bump is a full-app release cycle for you, not an `npm update`. For a *local dev tool* this is a meaningful tax versus Playwright shipping a browser download once via `npx playwright install`.

**Where Electron wins decisively:** native window chrome for the human ride-along view is a first-class `BrowserWindow`/`WebContentsView`, not a screencast-frame-in-a-`<canvas>` reconstruction — real scrollbars, real DPI handling, real IME, zero screencast-frame latency/artifacting. If "a human can literally look at and touch the live page" is a top-tier requirement (per Glassbox's stated core hypotheses it is), Electron is the only option in this comparison that gives it natively rather than via CDP screencast reconstruction.

---

## D. CEF / chromiumoxide-style embedding

**CEF (Chromium Embedded Framework).** A C/C++ framework for embedding Chromium in third-party apps (used by Steam, many game overlays). **No viable, maintained Node.js binding exists in 2026** — search turned up only dead projects: a "node-cef" that's actually an unrelated ArcSight logging library (last touched ~2012), a 2016 CEF-forum proof-of-concept ("Node-CEF/NC.js"), and misc proof-of-concept repos. Using CEF from Node would mean writing and maintaining your own N-API/FFI binding against libcef — a multi-month C++ undertaking disproportionate to a local dev tool. **Disqualified for this project on maintenance-burden grounds alone.** [npm search "cef"](https://www.npmjs.com/search?q=cef), [CEF forum Node-CEF thread](https://www.magpcss.org/ceforum/viewtopic.php?f=10&t=14263)

**chromiumoxide.** Not an embedding framework at all — it's a Rust **CDP client** (one Rust module per CDP/PDL domain), architecturally the Rust sibling of `chrome-remote-interface`/Playwright's CDP layer, not of CEF. It appears actively maintained into mid-2026 (PRs in May/June/July 2026 touching remote-debugging-pipes, CDP endpoints, browser module exports). Relevant to Glassbox only if the daemon were written in Rust; irrelevant to a Node/TS daemon except as a design reference for domain coverage. [github.com/mattsse/chromiumoxide](https://github.com/mattsse/chromiumoxide)

**Verdict:** CEF is disqualified (no Node binding, huge build/maintenance cost for zero benefit over Electron, which already solves "embed Chromium in my app" for Node). chromiumoxide is a fine *reference implementation* but the wrong language for this stack.

---

## E. Exotic engines (Lightpanda, Servo, Ladybird)

**Lightpanda.** A from-scratch headless browser written in Zig, purpose-built for AI-agent/scraping workloads, exposing a **CDP-compatible server** so "any existing Playwright or Puppeteer script can point at Lightpanda as a drop-in backend — zero code changes." The headline number: **~16MB RSS for a single page vs. 1.2GB+ for a full Chrome-based stack**, and ~48MB for 3 concurrent sessions vs. hundreds of MB to multiple GB for Chrome-based tools. It achieves this by **skipping CSS rendering entirely** and focusing on DOM/JS execution — i.e., it has no layout/paint pipeline. Still explicitly in **beta**: "some websites won't work perfectly," stability caveats specifically noted for Playwright integration. [scrapingbee Lightpanda writeup](https://www.scrapingbee.com/blog/lightpanda-headless-browser/), [lightpanda.io](https://lightpanda.io/), [dev.to memory benchmark](https://dev.to/atani/16mb-vs-12gb-benchmarking-5-ai-browser-automation-tools-34pm)

**Disqualification reasoning for Glassbox specifically:** Glassbox's entire purpose is verifying **rendered UI** — layout, screenshots, visual a11y, CSS cascade. A no-CSS-rendering engine cannot do the one thing this tool exists to do. Lightpanda is the right engine for "does this JS-heavy page contain text X," the wrong engine for "does this button render at 44px on mobile." Confirmed disqualified, and confirmed *why* (not layout/paint capable) rather than just "different vendor."

**Servo.** Actively developed 2026 (v0.0.6, March 2026, "speeds up layout and enhances DevTools") but its DevTools work targets **Firefox's protocol lineage**, not CDP, and it remains pre-1.0 / research-grade. No CDP compatibility surfaced in search.

**Ladybird.** First alpha (Linux/macOS) targeted for 2026, built from scratch, "not a fork of an existing engine." Explicitly landing **Firefox DevTools protocol** support, not CDP. No Windows build maturity implied by anything found, and — like Servo — no CDP compatibility layer, which is disqualifying on its own since Glassbox's entire tool-chain premise (Playwright/Puppeteer/hand-rolled clients, DevTools-frontend reuse) is CDP-shaped. [ladybird.org/news](https://ladybird.org/news/), [ladybird.org](https://ladybird.org/)

**Broader 2026 protocol context:** Firefox itself **deprecated CDP support as of Firefox 129**, standardizing instead on **WebDriver BiDi** (now a ratified W3C spec) as the cross-browser protocol. This is worth flagging as a future fork in the road — if Glassbox ever wants cross-engine verification (not just Chromium), BiDi is the emerging standard, not CDP — but for a Chromium-only local tool in 2026, CDP remains the correct, best-supported target. [Zylos research 2026 landscape](https://zylos.ai/research/2026-04-05-browser-automation-ai-agents-2026-landscape/)

---

## Resource cost: N contexts vs. N processes

Concrete numbers, single source of truth being the closest public analog to Glassbox's exact workload (`dev.to` benchmark of 5 AI browser automation tools, single page then 3 parallel sessions):

| Tool | 1 session (RSS) | 3 parallel sessions |
|---|---|---|
| Lightpanda | 16 MB (1 proc) | ~48 MB |
| steel-browser (Docker, Puppeteer+CDP) | 581 MB | — |
| browser-use | 869 MB (111MB daemon + 758MB browser, 8 procs) | — |
| **playwright-CLI** | **929 MB (169MB daemon + 760MB browser, 7 procs)** | **559 MB total** (note: benchmark's per-session number, not additive — Playwright's context-sharing is doing real work here) |
| agent-browser | 1,202 MB (5MB daemon + 1,197MB browser, 10 procs) | 4,165 MB |

[dev.to 16MB-vs-1.2GB benchmark](https://dev.to/atani/16mb-vs-12gb-benchmarking-5-ai-browser-automation-tools-34pm)

Qualitative complement from Playwright's own docs/guides: "each new browser **launch** is expensive (new process, new memory allocation); **contexts** are cheap (same process, isolated state)... a single container running one context uses ~500MB–1GB at idle, 2GB+ under multi-context load." Two contexts in one browser "behave like two incognito windows" — isolated cookies/storage but **sharing the underlying renderer-process pool**, which is the actual mechanism behind the memory savings. [qaskills.sh contexts guide](https://qaskills.sh/blog/playwright-browser-contexts-isolation-guide)

**Crash isolation trade-off, unavoidable and worth naming explicitly for Glassbox:** contexts sharing a browser process share fate on a **browser-process-level crash** (rare — GPU process crashes, out-of-memory kills, sandbox escapes) but are isolated from **renderer-process-level crashes**, since each tab/frame in Chromium already gets its own renderer process by default (site isolation). So "N contexts, 1 browser process" gives you renderer-crash isolation for free (a page that crashes its renderer doesn't take out sibling sessions) but not browser-process-crash isolation (an OOM-killed browser process takes every context in it down together). For a tool running possibly dozens of named agent sessions, **N processes gives true isolation at multiple-GB cost; N contexts in a pool of, say, 4–8 browser processes gives 90% of the isolation at a fraction of the memory** — the standard sharding compromise, and the one Playwright's own contexts model is implicitly optimized for.

---

## Headed vs. headless=new fidelity (2026)

Chrome fully removed the old, divergent headless-rendering-engine path in **Chrome 123 (2024)**; "new headless" (`--headless=new`) now runs the **same rendering pipeline** as headed Chrome — same Blink, same compositor. Playwright correspondingly ships a separate lightweight `chromium-headless-shell` binary that still follows the *old* headless behavior for speed, but the *default* `headless: true` in current Playwright uses real-Chrome-pipeline "new headless," with `--no-shell` letting you skip downloading the legacy shell entirely. [browserstack headless guide 2026](https://www.browserstack.com/guide/playwright-headless-chrome), [github.com/microsoft/playwright issue #33566](https://github.com/microsoft/playwright/issues/33566)

Residual, real differences that survive the pipeline unification:
- Font/subpixel rendering and GPU-accelerated compositing can differ subtly depending on whether a real display/GPU is available — "only a full browser will reveal subtle rendering issues in fonts, GPU acceleration, or CSS." [helpmetest headless guide](https://helpmetest.com/blog/headless-chrome/)
- Interaction-dependent states — hover, tooltips, drag-and-drop, viewport-dependent behaviors — can differ, because headless has no real OS-level input/focus/window-manager stack behind it. This is directly relevant to Glassbox's layout/a11y verification claims: a hover-triggered tooltip visible in headed mode may not render identically headless.
- Practitioner consensus for 2026: run automation in headless for speed, but **do visual verification (screenshots, manual QA, interactive debugging) in a real headed browser** — precisely because headless's remaining fidelity gap concentrates exactly in the areas Glassbox cares about (visual layout, hover states). This is a strong argument for Glassbox defaulting to **headed** (or at minimum offering it as the default, not an opt-in) rather than treating headless as good enough because "the pipeline is unified now."

---

## Hosting the DevTools frontend standalone, pointed at an arbitrary CDP URL

Three concrete, verified paths:

1. **`chrome-devtools-frontend` on npm.** A near-daily-published mirror of Chromium's actual `front_end/` sources; version numbers are literal Chromium commit positions (e.g. `1.0.373466`). Not CJS/ESM-packaged cleanly — "consuming this package in other tools may require some effort" — but it's the ground truth UI. You'd serve it statically and open `devtools.html?ws=<host:port/path>` pointed at your own CDP endpoint (this is exactly the mechanism Chrome's own remote-debugging landing page and Cloudflare's `live.browser.run` both use — see below). [npmjs.com/package/chrome-devtools-frontend](https://www.npmjs.com/package/chrome-devtools-frontend), [github.com/ChromeDevTools/devtools-frontend](https://github.com/ChromeDevTools/devtools-frontend)
2. **The public `chrome-devtools-frontend.appspot.com` hosted instance.** Google runs this specifically so people remote-debugging older/mobile Chrome versions can get a version-matched frontend; historically the `devtoolsFrontendUrl` returned by `/json` already encodes the `?ws=` param pointing back at your target. Usable for local dev, but pointing a hosted third-party origin at your local CDP socket is a privacy/CSP smell for anything beyond quick manual debugging — don't build Glassbox's primary UX on it. [groups.google.com discussion](https://groups.google.com/d/topic/google-chrome-developer-tools/vFayYdcT9nk)
3. **Cloudflare Browser Rendering's pattern, as a proven reference architecture.** Every CDP target response includes a `devtoolsFrontendUrl`; opening it loads a DevTools UI hosted at `live.browser.run` that "streams the remote session to your browser" — i.e., exactly "host DevTools frontend, point it at an arbitrary ws:// URL" at production scale. Confirms the pattern is sound and battle-tested, not just a hack. [developers.cloudflare.com/browser-run/cdp](https://developers.cloudflare.com/browser-run/cdp/)

A fourth option worth naming even though it's not "DevTools frontend" per se: **`chii`** (liriliri) — "remote debugging tool... replaces the web inspector with the latest Chrome DevTools frontend," installed via `npm install chii -g`, works by injecting a `target.js` script tag into the debuggee page rather than connecting over CDP to a real browser process. Wrong shape for Glassbox (it debugs *in-page* via injected JS, not the browser process via CDP) but useful prior art for "how do people self-host a DevTools-like UI." [github.com/liriliri/chii](https://github.com/liriliri/chii)

**Recommendation on this sub-question:** vendor a pinned copy of `chrome-devtools-frontend` (or check out a matching Chromium revision's `front_end/`), serve it from the local daemon over loopback only, and hand it the ws URL for whichever session a human wants "real DevTools, not a custom UI" access to. This is strictly better than reimplementing a Sources/Elements/Network panel — and is exactly the `devtoolsFrontendUrl` mechanism CDP was designed around.

---

## CDP screencast-based viewers, prior art

- **`Page.startScreencast`/`screencastFrame`/`stopScreencast`** is the native CDP mechanism — base64 JPEG/PNG frames with `format`, `quality`, `maxWidth`, `maxHeight`, `everyNthFrame` params. This is the same primitive Cypress uses for headless video capture. [getting-started-with-cdp](https://github.com/aslushnikov/getting-started-with-cdp/blob/master/README.md)
- **Playwright CLI's `show` dashboard** (see §0) is the most directly relevant prior art: a session grid of live screencast tiles, click-to-zoom into full remote control, click-to-take-over mouse/keyboard, Escape to release.
- **Browserbase Live View**: "a real-time iframe of the running browser... embed in your own app... a human [can] take over a single step without the agent losing its place." [docs.browserbase.com live-view](https://docs.browserbase.com/platform/browser/observability/session-live-view)
- **Steel.dev**: a debug-URL-driven iframe embed of the live session; also records full sessions in **rrweb** format (DOM-mutation replay, not just video) via an events endpoint — worth considering for Glassbox's "artifacts on disk" requirement, since rrweb-format replay is smaller and more inspectable than video. [steel-dev/steel-browser](https://github.com/steel-dev/steel-browser)
- **Mastra's `BrowserViewer`**: streams frames and auto-recreates the CDP session across tab switches — a useful implementation detail (screencast sessions don't survive a `Target` switch automatically; you must re-`startScreencast` against the new target).

Pattern convergence: every serious implementation is "iframe or canvas fed by `Page.startScreencast` frames, plus a second CDP channel (`Input.dispatchMouseEvent`/`dispatchKeyEvent`) for takeover, plus a grid/list view keyed by session name." This is a solved, well-understood pattern — build vs. buy is a non-issue, it's a day or two of implementation once the CDP plumbing exists.

---

## Windows process cleanup: how Playwright/Puppeteer actually do it

Puppeteer's documented approach (and by lineage, Playwright's): **use `taskkill /pid <pid> /T /F`** on Windows rather than `process.kill()`, specifically because Windows has no POSIX process-group signal semantics — `/T` is "terminate all child processes along with the parent (tree kill)," `/F` is "force." Puppeteer's `Launcher.ts` **falls back to `subprocess.kill()` if `taskkill` itself fails** (e.g., insufficient privileges) — a belt-and-suspenders pattern captured across several PRs (#8352 "kill browser process when taskkill fails," #8477 "kill browser process when killing process group fails"). [github.com/puppeteer/puppeteer PR #8352](https://github.com/puppeteer/puppeteer/pull/8352), [PR #8477](https://github.com/puppeteer/puppeteer/pull/8477)

Why not native Windows Job Objects (the "correct" primitive — `CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` guarantees the whole tree dies when the job handle closes, even on a hard crash of the parent)? Because plain Node has no built-in binding for it. VS Code hit the same wall and ships **`@vscode/windows-process-tree`**, a native N-API module purpose-built to enumerate a Windows process tree in <20ms (the unmaintained community `windows-process-tree` predecessor is explicitly deprecated in its favor). Some newer tooling (e.g. the `pacquet` package manager, cited in a 2026 pnpm issue thread) has started using real Job Objects with `KILL_ON_JOB_CLOSE` for more robust cleanup than `taskkill /T /F` — which is a good idea in principle but adds a native-module build dependency, exactly the kind of thing Glassbox should weigh against its "zero-dependency Node ESM" instinct (borrowed from WCII's own house style, appropriately). [github.com/microsoft/vscode-windows-process-tree](https://github.com/microsoft/vscode-windows-process-tree), [npmjs.com/package/@vscode/windows-process-tree](https://www.npmjs.com/package/@vscode/windows-process-tree), [pnpm issue #12406](https://github.com/pnpm/pnpm/issues/12406)

**Ground truth: nobody has actually solved this.** Even Microsoft's own `playwright-mcp`, built on the same Puppeteer-lineage taskkill approach, has open 2026 issues for exactly this class of bug (#1458 zombie headed Chrome after close; #1568 orphaned headless Chrome after stdio transport closes). Practical implication for Glassbox: **budget for a `kill-all`/reaper command from day one** (as both Playwright CLI and playwright-mcp had to add), don't treat "we call taskkill /T /F so we're done" as sufficient, and consider periodic orphan-sweep (find `chrome.exe`/`msedge.exe` processes whose parent PID no longer exists and whose `--remote-debugging-port` matches a Glassbox-owned range) as a background safety net rather than relying purely on exit-path cleanup.

---

## Recommended architecture, with reasoning

**Core: Playwright-as-library (Option A), Node 24 host, daemon-owned, CDP-first for anything Playwright doesn't cover.**

1. **Daemon owns the browser(s), like Playwright CLI already validated.** One long-lived Node process launches and owns a small pool of real Chromium **processes** (not just contexts) — recommend **1 browser process per ~4–8 concurrent named sessions**, sessions within a pool-member as Playwright `BrowserContext`s. This buys renderer-crash isolation "for free" via Chromium's own site isolation while keeping memory bounded (per the benchmark table: a single Playwright-driven browser process serving multiple contexts stays in the ~800MB–1GB range vs. multi-GB for N full processes), and caps blast radius (an OOM'd browser process only takes its own shard of sessions with it, not all of them).
2. **Headed by default, not headless.** The 2026 fidelity research is unambiguous that hover/tooltip/DPI/font-rendering edge cases — precisely what a UI-verification tool exists to catch — are exactly where headless still diverges from headed, pipeline-unification notwithstanding. Headless should be an explicit opt-in for CI/throughput use, not the default for a tool whose job is visual truth.
3. **Use Playwright for launch, context/target lifecycle, and input dispatch — the parts with years of cross-target, cross-platform hardening behind them (auto-attach to popups/iframes, actionability waits, the CfT-aligned bundled binary as of 1.57).** Do not hand-roll a target-lifecycle layer; that's the highest-value, hardest-to-get-right part of both Puppeteer's and Playwright's codebases, and Electron's own `webContents.debugger` auto-attach bugs (#27768, #35318) are a live demonstration of how easy this is to get wrong even for Chromium's own embedder.
4. **Drop to raw CDP (Playwright's `CDPSession`, or a hand-rolled native-`WebSocket` client for anything Playwright's session object can't reach) for the deep white-box features that are Glassbox's actual differentiator and that Playwright CLI conspicuously lacks:** `Debugger.setBreakpointByUrl`/`Debugger.pause` for breakpoint debugging, `Profiler.startPreciseCoverage`/`CSS.startRuleUsageTracking` for JS/CSS coverage (the exact CDP calls underlying Puppeteer's `page.coverage`), and `CSS.getMatchedStylesForNode` for cascade introspection (the exact call DevTools' own Styles pane uses). None of these are exposed by Playwright's high-level API; all are reachable from a `CDPSession` obtained off a Playwright-managed page, so you get Playwright's lifecycle safety *and* CDP's full power without owning a target-discovery layer yourself.
5. **A Node 24 native-`WebSocket` client (zero extra dependency) is viable and recommended for any bespoke CDP connections outside Playwright's own session objects** — e.g., a lightweight bridge if you want a session's CDP endpoint reachable by an external DevTools frontend without going through Playwright's own transport. Native `fetch` + native `WebSocket`, both stable in Node 24, cover 100% of what `chrome-launcher`+`chrome-remote-interface` need at the transport layer; the only thing worth keeping from that ecosystem conceptually (not necessarily as a dependency) is `chrome-launcher`'s binary-discovery logic, which Playwright's own launcher already subsumes.
6. **Human ride-along: host a pinned `chrome-devtools-frontend` build over loopback, and separately build a lightweight `Page.startScreencast`-driven session grid** (Playwright CLI's `show` dashboard is the reference pattern to match/exceed) for at-a-glance multi-session viewing, with click-to-take-over via `Input.dispatch*Event`. Two different UX needs, both cheap once the CDP session plumbing exists: the grid for "what are my N agents doing right now," full DevTools-frontend for "let me actually debug this one session like I would debug my own open tab."
7. **Windows cleanup: don't trust taskkill alone.** Use the same `taskkill /pid <pid> /T /F` with `subprocess.kill()` fallback that Puppeteer/Playwright use (proven, no extra native dependency), but add (a) an explicit `kill-all`/reaper CLI command from day one — both Playwright CLI and playwright-mcp needed one, so Glassbox will too — and (b) a background orphan sweep that finds Chromium processes launched by Glassbox (tag via a custom `--user-data-dir` naming convention or a marker CLI flag) whose parent PID is gone, and reaps them. Treat `@vscode/windows-process-tree` (or genuine Job Objects with `KILL_ON_JOB_CLOSE`) as a later hardening step once the basic pattern is proven, not a v1 dependency, consistent with the zero-dep instinct.
8. **Electron: not the core runtime, but keep it on the shortlist for a v2 "native ride-along window."** Nothing here should be built assuming Electron, because (a) the Chromium-version-lag tax is real even if bounded (~1–8 weeks) and becomes *your* security-patch latency, (b) no clean path exists to reuse Playwright's context/target-lifecycle code inside an Electron `webContents` without re-deriving it against `webContents.debugger`'s auto-attach bugs, and (c) a screencast-in-a-browser-tab ride-along view (item 6) gets you 90% of the human-usability win at a fraction of the packaging/update cost. If a future iteration wants truly-native window chrome for ride-along instead of a reconstructed screencast, an Electron *shell that itself connects out to the daemon's CDP endpoints* (rather than owning its own browser) is the way to get there without duplicating target-lifecycle logic.
9. **CEF: hard no** — no maintained Node binding exists in 2026, and building one is a multi-month C++/N-API project with no functional upside over Electron. **Lightpanda/Servo/Ladybird: hard no for the core engine** — Lightpanda by design skips CSS layout/paint (disqualifying for a UI-verification tool), Servo/Ladybird target Firefox-lineage DevTools protocol, not CDP, and neither is Windows-mature or CDP-compatible in 2026. Revisit only if/when WebDriver BiDi (Firefox's post-CDP standard) becomes a real cross-engine requirement for Glassbox — not now.

**Net shape:** Playwright is the chassis (launch, contexts, targets, input, the Chrome-for-Testing-aligned binary); raw CDP (via Playwright's own `CDPSession` plus a thin native-`WebSocket` bridge where needed) is the engine access panel for breakpoints/coverage/cascade; a hosted DevTools frontend and a screencast grid are the two human-facing views; Node 24's native `fetch`/`WebSocket` keep the whole thing dependency-light without reinventing target-lifecycle correctness. This is architecturally the same bet Microsoft's own `playwright-cli` team made — validating it's sound — with Glassbox differentiating specifically in the white-box-debugging layer that tool left on the table.

---

## Sources

- [Playwright CLI — TestDino guide](https://testdino.com/blog/playwright-cli)
- [Playwright CLI — official docs, "Coding agents"](https://playwright.dev/docs/getting-started-cli)
- [microsoft/playwright-cli on GitHub](https://github.com/microsoft/playwright-cli)
- [TesterArmy — "Inside Playwright CLI" architecture deep-dive](https://tester.army/blog/inside-playwright-cli-browser-automation-for-coding-agents)
- [Playwright docs — CDPSession](https://playwright.dev/docs/api/class-cdpsession)
- [Playwright docs — browserType.connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
- [Playwright docs — Browser Contexts / Isolation](https://playwright.dev/docs/browser-contexts)
- [QASkills.sh — Playwright Browser Contexts & Isolation Guide](https://qaskills.sh/blog/playwright-browser-contexts-isolation-guide)
- [QASkills.sh — Chrome for Testing vs Chromium in Playwright](https://qaskills.sh/blog/chrome-for-testing-vs-chromium-playwright)
- [QASkills.sh — Playwright `await using` automatic cleanup](https://qaskills.sh/blog/playwright-await-using-automatic-cleanup-guide)
- [microsoft/playwright-mcp issue #1458 — zombie headed Chrome](https://github.com/microsoft/playwright-mcp/issues/1458)
- [microsoft/playwright-mcp issue #1568 — orphaned headless Chrome](https://github.com/microsoft/playwright-mcp/issues/1568)
- [GoogleChrome/chrome-launcher README](https://github.com/GoogleChrome/chrome-launcher/blob/main/README.md)
- [cyrus-and/chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface)
- [Node.js v24.0.0 release blog — stable native WebSocket](https://nodejs.org/en/blog/release/v24.0.0)
- [LogRocket — What's new in Node.js 24](https://blog.logrocket.com/node-js-24-new/)
- [Electron docs — webContents.debugger](https://www.electronjs.org/docs/latest/api/debugger)
- [Electron docs — WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [electron/electron issue #27768 — CDP Fetch domain + auto-attach crash](https://github.com/electron/electron/issues/27768)
- [electron/electron issue #35318 — Target.attachedToTarget not emitted](https://github.com/electron/electron/issues/35318)
- [electron/electron issue #23035 — debugger.attach blocks requests](https://github.com/electron/electron/issues/23035)
- [Electron Releases — timelines / Chromium cadence](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
- [Electron Releases — schedule](https://releases.electronjs.org/schedule)
- [mattsse/chromiumoxide on GitHub](https://github.com/mattsse/chromiumoxide)
- [npm search — "cef" (no maintained Node CEF binding)](https://www.npmjs.com/search?q=cef)
- [CEF Forum — Node-CEF (NC.js) thread](https://www.magpcss.org/ceforum/viewtopic.php?f=10&t=14263)
- [ScrapingBee — Lightpanda headless browser](https://www.scrapingbee.com/blog/lightpanda-headless-browser/)
- [Lightpanda.io](https://lightpanda.io/)
- [dev.to — 16MB vs 1.2GB, benchmarking 5 AI browser automation tools](https://dev.to/atani/16mb-vs-12gb-benchmarking-5-ai-browser-automation-tools-34pm)
- [Ladybird Browser — News](https://ladybird.org/news/)
- [Ladybird Browser — homepage](https://ladybird.org/)
- [Zylos Research — Browser Automation at Scale 2026 landscape](https://zylos.ai/research/2026-04-05-browser-automation-ai-agents-2026-landscape/)
- [BrowserStack — How to Run Tests in Playwright Headless Chrome 2026](https://www.browserstack.com/guide/playwright-headless-chrome)
- [microsoft/playwright issue #33566 — headless mode changes in 1.49](https://github.com/microsoft/playwright/issues/33566)
- [HelpMeTest — Headless Chrome complete guide 2026](https://helpmetest.com/blog/headless-chrome/)
- [npmjs.com/package/chrome-devtools-frontend](https://www.npmjs.com/package/chrome-devtools-frontend)
- [ChromeDevTools/devtools-frontend on GitHub](https://github.com/ChromeDevTools/devtools-frontend)
- [Google Groups — how to serve the DevTools frontend remotely](https://groups.google.com/d/topic/google-chrome-developer-tools/vFayYdcT9nk)
- [Cloudflare Browser Run docs — CDP](https://developers.cloudflare.com/browser-run/cdp/)
- [liriliri/chii on GitHub](https://github.com/liriliri/chii)
- [aslushnikov/getting-started-with-cdp](https://github.com/aslushnikov/getting-started-with-cdp/blob/master/README.md)
- [Browserbase docs — Session live view](https://docs.browserbase.com/platform/browser/observability/session-live-view)
- [steel-dev/steel-browser on GitHub](https://github.com/steel-dev/steel-browser)
- [puppeteer/puppeteer PR #8352 — kill browser when taskkill fails](https://github.com/puppeteer/puppeteer/pull/8352)
- [puppeteer/puppeteer PR #8477 — kill on process-group-kill failure](https://github.com/puppeteer/puppeteer/pull/8477)
- [microsoft/vscode-windows-process-tree on GitHub](https://github.com/microsoft/vscode-windows-process-tree)
- [npmjs.com/package/@vscode/windows-process-tree](https://www.npmjs.com/package/@vscode/windows-process-tree)
- [pnpm issue #12406 — Windows process-tree kill via taskkill /T /F](https://github.com/pnpm/pnpm/issues/12406)
