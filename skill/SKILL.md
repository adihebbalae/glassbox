---
name: glassbox
description: Verify and debug your own web UI on localhost. Use when you changed frontend code and need to check it actually works — console/network errors, layout/contrast/a11y problems, dead buttons, wrong colors, broken handlers — or when testing a dev server, reproducing a UI bug, or debugging why an element behaves wrong. Drives a real Chromium via named parallel sessions with a white-box debugger; returns structured findings and on-disk artifacts, not screenshots you have to squint at.
---

# Glassbox — instrumented browser for verifying your own UI

You wrote the code; Glassbox checks it against a real browser and tells you, in structured findings, exactly what's broken and where. It is not a general web agent — it's a verification-and-debug plane for the UI you are building.

Every tool is `gb_*` and takes a `session` (except `gb_session open`). One daemon runs the browser; the MCP tools are thin proxies. Screenshots and full reports are written to a per-session **artifact directory on disk** and returned as **paths** — if you need to see an image, `Read` the path (inline images cost 10-20x the tokens).

## 1. Session-per-agent (the core pattern)

Open ONE session named for your task. Parallel agents/subagents each open their OWN session — never share one (refs, navigation, and breakpoints are per-session).

```
gb_session {op:"open", name:"checkout-form"}      → info + a watchUrl for humans
```

Options: `headed:true` (visible window — for hover/tooltip/GPU-sensitive checks), `viewport:{width,height}`, `colorScheme:"dark"`, `baseUrl` (then `gb_goto` takes relative paths), your site's own theme switch so `verify` can sweep it — `themeAttr:"data-theme"` (attribute) or `themeClass:"dark"` (**Tailwind `darkMode:['class']`** — the common one) — and `ignore404:["/favicon.ico"]` for 404s you already know about.

Need a different viewport later? Resize in place instead of opening a second session: `gb_session {op:"resize", name:"checkout-form", viewport:{width:390,height:844}}` (CLI: `glassbox session resize checkout-form 390x844`).

**Cleanup — you are sharing this daemon.** ONE Glassbox daemon serves every agent on the machine, so sessions are **owned**: whoever opened one owns it. The MCP shim identifies itself automatically (`mcp-<pid>`); CLI agents `export GLASSBOX_CLIENT=my-task` once, or pass `--client my-task`. Clean up with either of:

```
gb_session {op:"close", name:"checkout-form"}     ← one session
glassbox kill-all --mine                          ← every session YOU opened (CLI)
```

`kill-all --mine` is the standard end-of-task cleanup: it leaves the daemon, and every other agent's live work, untouched — and stops the daemon only when nothing is left in it. A **bare** `glassbox kill-all` targets the whole daemon and is **refused** while another client's sessions are in use (it names them). `--force` overrides that: it is a machine-wide clean slate — every session, every Glassbox Chromium, every Glassbox daemon, *including another agent's in-progress verification*. Reach for it only when something is genuinely wedged, and know what you are ending.

If your sessions vanish and calls start returning `NO_SESSION`, read the `daemon` line in the error: a pid different from the one your `session open` printed means the daemon restarted (or someone forced it down) and took every session with it. Re-open and re-navigate; nothing is recoverable.

## 2. Verify-first workflow (do this every change)

The loop is: **goto → verify → read findings → fix code → re-verify.**

```
gb_goto   {session, url:"http://localhost:5173/checkout"}
gb_verify {session}          ← THE tool. one call = console + network + layout + a11y + overlay + screenshot
```

`gb_verify` returns `ok` plus `counts` and the top `findings` (each a sentence you can act on, e.g. `"2 requests failed: GET /api/cart → net::ERR_CONNECTION_REFUSED"`). `ok:false` means fix something. Full detail + screenshots are at the returned `artifacts.report` path. Add `themes:true` to sweep light+dark, `viewports:true` for mobile+desktop, `scope:"#cart"` to audit one subtree.

`counts.consoleErrors` is `console.error` entries **since the last navigation** — not the whole console buffer (use `gb_read {channel:"console"}` for that; an action delta's `console` is every message emitted during that one action, at every level). The theme sweep **reloads the page per leg** so a site that reads `prefers-color-scheme` once at boot is actually re-themed (pass `themeReload:false` to keep in-page state); if the light and dark screenshots come out byte-identical, that is reported as a finding rather than left to look like a passing dark-mode check.

**Cold vs warm — read the `navigation` field before you believe a clean result.** A second load of the same URL is *warm*, and a warm load quietly loses real first-visit findings: CLS is a first-paint race a warm load wins (measured 0.1734 → 0 on a real page), and a negatively-cached 404 like `/favicon.ico` is never re-requested. Every report says which it measured, and a warm one carries an explicit warning. When first-load behaviour matters, pass `cold:true` (`--cold`) — it clears the HTTP cache and re-navigates before measuring. (Sub-resources are always re-fetched, cache-disabled; the browser's own favicon cache is outside CDP's reach, so for that one use a fresh session.)

Noise you should EXPECT to see collapsed rather than listed: `Ignored 404s: N` when you set `ignore404` (only status-404 rows are demoted — the same path failing 500 still reports, and demoted rows stay in the on-disk report), `Modal open; N behind backdrop`, `N interactive elements in deferred section …; scroll to audit` for `content-visibility:auto` sections that have not painted yet, and `N interactive elements in a collapsed <details> ('summary text'); open to audit` for native accordions and `hidden="until-found"` regions. The last two are **not** defects — they are progressive disclosure, and the content paints on toggle/scroll. If you want what is inside audited, open or scroll the widget (`gb_act {action:"click", selector:"details > summary"}`) and re-verify.

When the audit genuinely cannot explain a hide it says so instead of guessing: *"cause is outside the DOM ancestor chain — every ancestor computes content-visibility:visible"* means a UA pseudo-element or shadow root is doing it. Naming a mechanism the computed styles contradict would send you to fix the wrong thing.

Pull one channel at a time with `gb_read {session, channel}`:
- `errors` — console.error + uncaught exceptions, source-map-remapped to your original files
- `console` — everything
- `network` — the `failed | httpError | hanging | mixedContent` taxonomy (a 404/500 is transport-success, so naive listeners miss it — this doesn't)
- `overlay` — Vite/Astro/Next build-error overlay text, extracted structurally

## 3. Selector-first grounding

You wrote the markup, so **act by your own selector** — no snapshot needed:

```
gb_act {session, action:"click", selector:"#submit"}
gb_act {session, action:"type", selector:"#email", value:"a@b.com", submit:true}
```

`gb_act` is one tool; `action` ∈ click|dblclick|hover|type|press|scroll|drag|upload|select. Target by `selector` (preferred) | `testid` | `role`+`name` | `text` | `ref`. It returns a **delta** (url change, console, mutations, settled) — not a page dump.

**A click you can't make, it won't make.** If something covers the target at its hit point, the click fails with `ACT_OCCLUDED` naming the covering element (`occludedBy`) — that is a real bug in your UI, the same one `gb_verify` reports as an occlusion, not a Glassbox quirk. Fix the z-order/close the overlay, or pass `force:true` to dispatch at that point anyway; a forced action is stamped `forced:true` (+ `occludedBy`) in the delta and the journal, so it can never read like an ordinary click.

Only reach for `gb_observe` when you DON'T know the DOM: it returns a distilled tree with numbered refs (`e1`, `e2`, …) as plain text (~1.4k tokens, not 95k). Refs die on the next DOM mutation — if you get a `STALE_REF` error, just re-observe (the error says so).

## 4. Debug recipes (white-box)

| Symptom | Move |
| --- | --- |
| Button does nothing | `gb_debug {session, op:"listeners", selector:"#btn"}` — read the `verdict`, not just the empty array (see below) |
| Wrong / invisible color | `gb_style {session, selector:"#el"}` — computed color, contrast ratio, and the cascade with each rule marked won ✓ / overridden ✗ (with real specificity) |
| Handler logic is wrong | `gb_debug {op:"break", file:"cart.js", line:42}` → trigger it → `gb_debug {op:"inspect"}` (locals) → `gb_debug {op:"eval", expression:"total*qty"}` → `gb_debug {op:"step", mode:"over"}` → `gb_debug {op:"resume"}` |
| Code you expected never ran | `gb_coverage {op:"start"}` → exercise the UI → `gb_coverage {op:"stop"}` → report lists functions with count 0 |
| Read/compute app state | `gb_eval {session, expression:"window.store.getState().cart"}` — returns the value + any console it logged |

**Reading `listeners` correctly (it is easy to get a wrong verdict here):** the result echoes `element` (the node it actually inspected), `matchCount` + a `warning` when your selector matched several nodes — a bare `"button"` inspects the FIRST button in the DOM, often a hidden mobile hamburger — and `delegated`, the ancestors that DO carry handlers. An empty `listeners` array alone does **not** mean "no handler wired": React 17+ attaches every synthetic handler at the root container, so the honest answer is in `verdict` — either *"no direct listeners; ancestor #root has delegated click…"* (the button probably works; go read the component) or *"no direct listeners and no delegated listeners on any ancestor (dead element)"* (now it's dead). Target precisely with a `ref` from `gb_observe` when the selector is ambiguous.

**PAUSED lane semantics (important):** while a breakpoint is paused, `state / inspect / eval / step / resume / pause / screenshot / listeners` all work — but **every non-debug tool returns a `PAUSED` error**. That's not a failure; it's telling you to `gb_debug {op:"resume"}` first (or keep debugging). A paused handler also blocks the action that triggered it — expected; resume to let it finish.

## 5. Waiting, screenshots, artifacts

- `gb_wait {session, for:{selector:"#done"}}` — targeted wait; `for` is one of `{selector}|{text}|{url}|{hydration:true}|{timeout:ms}`. It **never throws on timeout** — it returns `matched:false` so you branch.
  - `{url:"/dashboard"}` (leading slash) matches the **pathname**: `/dashboard` and `/dashboard/settings`, never `/dashboardx`. Without the slash it's a substring of the full href (`{url:"dashboard"}`); `*` globs. From the CLI **in Git Bash**, `--url /dashboard` is rewritten by MSYS into a Windows path before Node sees it — Glassbox un-mangles it, but `--url dashboard` is the bulletproof form.
  - `{timeout:ms}` is a plain sleep: it owns its own budget, always succeeds after the duration, and exits 0 (safe in an `&&` chain).
- `gb_screenshot {session}` — writes a webp to the shots/ dir and returns the PATH. `fullPage`, `selector` (clip to one element), `theme` options. To actually see it, `Read` the path. `fullPage` **and** `selector` captures first force `content-visibility:auto` sections to paint (they otherwise come back as blank paper — a screenshot that says "half your page is missing" when it isn't) and return `forcedPaint:N`. A `selector` capture is framed in page coordinates, so it is correct at any scroll position — including after a click that scrolled its target into view. If a clip of a visibly-populated element still comes out featureless you get a `warning` field saying so; never a silent blank.
- Artifacts pile up per session (shots/reports/net/journal). List them from the CLI: `glassbox artifacts -s <session>`.

## 6. Watch (bring a human in)

When your human wants to see or drive the browser you're testing:

```
gb_watch {session}   → { watchUrl, devtoolsFrontend }
```

Give them `watchUrl` (a live screencast + click/key takeover page). `devtoolsFrontend` pastes into a Chromium address bar for real DevTools against the same tab.

## 7. Dev-server loop (CLI, via Bash)

When you're iterating against a dev server, run it *through* Glassbox instead of starting it yourself — one command spawns it, finds its URL in its own output, attaches a session, and verifies:

```
glassbox dev --cmd "npm run dev" --cwd . -s dev        # streams until you stop it (q + Enter)
glassbox dev --cmd "npm run dev" --no-attach           # just print the discovered URL and exit
```

It prints the ready URL, a watch URL for your human, and the first `verify`. After that, every rebuild the server logs is journaled and re-checks the build-error overlay, printing `BUILD ERROR [vite] …` when your edit doesn't compile. Add `--auto-verify` to re-run the full verify on each rebuild. The session it attaches (`dev` by default) is a normal session — keep using `gb_verify {session:"dev"}` and every other tool against it from MCP while the loop runs.

This one is CLI-only on purpose (the MCP tool surface is capped); run it with Bash, background it if you want to keep working, and stop it with `q` + Enter or `glassbox kill-all --mine`.

## 8. Worked example (compact)

```
gb_session {op:"open", name:"login-fix"}
gb_goto    {session:"login-fix", url:"http://localhost:3000/login"}
gb_verify  {session:"login-fix"}
   → ok:false, findings:["console.error: Cannot read properties of null (reading 'value') (login.js:12)"]
gb_debug   {session:"login-fix", op:"listeners", selector:"#login"}
   → count:0, delegated:[], verdict:"no direct listeners and no delegated listeners on any ancestor (dead element)"
     ← the submit button really was never wired
# …you fix login.js: attach the click handler…
gb_verify  {session:"login-fix"}
   → ok:true
gb_act     {session:"login-fix", action:"type", selector:"#user", value:"me", submit:true}
gb_wait    {session:"login-fix", for:{url:"/dashboard"}}
   → matched:true
gb_session {op:"close", name:"login-fix"}
```

## Notes

- Structured errors are self-correcting: a `STALE_REF`, `PAUSED`, `NO_SESSION`, `NO_TARGET`, or `ACT_OCCLUDED` result carries the code, a correction hint, and (for bad names/refs/coverers) the specifics — read it and retry, don't give up.
- Noise discipline in `verify`: while a modal is open its backdrop makes everything behind it unreachable BY DESIGN, so that whole batch collapses to one info line ("modal open; N interactive elements behind backdrop"); interactive elements hidden by an ancestor's `visibility:hidden` (Tailwind `.invisible` on a closed drawer) are one grouped warning naming that ancestor; `content-visibility:auto` sections are *deferred*, not hidden — one info line, no pathology. Facts, not floods.
- A low error count is only as good as the conditions it was measured in: warm load, cached fonts, allowlisted 404s. The report tells you all three — read them before you say "clean".
- A low error count is weak evidence of quality; verify after EVERY change, not once at the end.
- Cleanup: `glassbox kill-all --mine` ends your sessions and leaves everyone else's alone. Bare `kill-all` (whole daemon) refuses while another client is working; `--force` is the machine-wide last resort — it can end another agent's verification mid-run, which is a real incident, not a tidy-up.
