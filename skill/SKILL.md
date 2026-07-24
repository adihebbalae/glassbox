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

Options: `headed:true` (visible window — for hover/tooltip/GPU-sensitive checks), `viewport:{width,height}`, `colorScheme:"dark"`, `themeAttr:"data-theme"` (your site's own theme switch, so verify can sweep it), `baseUrl` (then `gb_goto` takes relative paths).

Close it when done: `gb_session {op:"close", name:"checkout-form"}`. To reap everything (daemon + all chromium) after a run: `glassbox kill-all` (CLI).

## 2. Verify-first workflow (do this every change)

The loop is: **goto → verify → read findings → fix code → re-verify.**

```
gb_goto   {session, url:"http://localhost:5173/checkout"}
gb_verify {session}          ← THE tool. one call = console + network + layout + a11y + overlay + screenshot
```

`gb_verify` returns `ok` plus `counts` and the top `findings` (each a sentence you can act on, e.g. `"2 requests failed: GET /api/cart → net::ERR_CONNECTION_REFUSED"`). `ok:false` means fix something. Full detail + screenshots are at the returned `artifacts.report` path. Add `themes:true` to sweep light+dark, `viewports:true` for mobile+desktop, `scope:"#cart"` to audit one subtree.

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

Only reach for `gb_observe` when you DON'T know the DOM: it returns a distilled tree with numbered refs (`e1`, `e2`, …) as plain text (~1.4k tokens, not 95k). Refs die on the next DOM mutation — if you get a `STALE_REF` error, just re-observe (the error says so).

## 4. Debug recipes (white-box)

| Symptom | Move |
| --- | --- |
| Button does nothing | `gb_debug {session, op:"listeners", selector:"#btn"}` — empty list = no handler wired |
| Wrong / invisible color | `gb_style {session, selector:"#el"}` — computed color, contrast ratio, and the cascade with each rule marked won ✓ / overridden ✗ (with real specificity) |
| Handler logic is wrong | `gb_debug {op:"break", file:"cart.js", line:42}` → trigger it → `gb_debug {op:"inspect"}` (locals) → `gb_debug {op:"eval", expression:"total*qty"}` → `gb_debug {op:"step", mode:"over"}` → `gb_debug {op:"resume"}` |
| Code you expected never ran | `gb_coverage {op:"start"}` → exercise the UI → `gb_coverage {op:"stop"}` → report lists functions with count 0 |
| Read/compute app state | `gb_eval {session, expression:"window.store.getState().cart"}` — returns the value + any console it logged |

**PAUSED lane semantics (important):** while a breakpoint is paused, `state / inspect / eval / step / resume / pause / screenshot / listeners` all work — but **every non-debug tool returns a `PAUSED` error**. That's not a failure; it's telling you to `gb_debug {op:"resume"}` first (or keep debugging). A paused handler also blocks the action that triggered it — expected; resume to let it finish.

## 5. Waiting, screenshots, artifacts

- `gb_wait {session, for:{selector:"#done"}}` — targeted wait; `for` is one of `{selector}|{text}|{url}|{hydration:true}|{timeout:ms}`. It **never throws on timeout** — it returns `matched:false` so you branch.
- `gb_screenshot {session}` — writes a webp to the shots/ dir and returns the PATH. `fullPage`, `selector` (clip to one element), `theme` options. To actually see it, `Read` the path.
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

This one is CLI-only on purpose (the MCP tool surface is capped); run it with Bash, background it if you want to keep working, and stop it with `q` + Enter or `glassbox kill-all`.

## 8. Worked example (compact)

```
gb_session {op:"open", name:"login-fix"}
gb_goto    {session:"login-fix", url:"http://localhost:3000/login"}
gb_verify  {session:"login-fix"}
   → ok:false, findings:["console.error: Cannot read properties of null (reading 'value') (login.js:12)"]
gb_debug   {session:"login-fix", op:"listeners", selector:"#login"}
   → [] (empty)  ← the submit button was never wired
# …you fix login.js: attach the click handler…
gb_verify  {session:"login-fix"}
   → ok:true
gb_act     {session:"login-fix", action:"type", selector:"#user", value:"me", submit:true}
gb_wait    {session:"login-fix", for:{url:"/dashboard"}}
   → matched:true
gb_session {op:"close", name:"login-fix"}
```

## Notes

- Structured errors are self-correcting: a `STALE_REF`, `PAUSED`, `NO_SESSION`, or `NO_TARGET` result carries the code, a correction hint, and (for bad names/refs) the list of valid values — read it and retry, don't give up.
- A low error count is weak evidence of quality; verify after EVERY change, not once at the end.
- Cleanup: `glassbox kill-all` reaps the daemon and every Glassbox-launched Chromium, leaving zero orphans.
