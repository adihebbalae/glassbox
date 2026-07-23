# Feasibility spikes — results (2026-07-23, pre-architecture)

All three spikes use **zero npm dependencies**: Node 24 built-ins only (`child_process`,
global `WebSocket`, `http`, `fs`) against Playwright's cached Chromium 148
(`%LOCALAPPDATA%\ms-playwright\chromium-1223\chrome-win64\chrome.exe`).

## Spike 1 — `cdp-spike.mjs`: raw-CDP core (PASS)
- Launch → DevTools ws banner: **940ms**. Two isolated browser contexts created in
  parallel: **+525ms**. Total cold start to two live sessions: ~1.5s.
- Storage isolation proven: localStorage + cookie written in context A invisible in B.
- `Page.captureScreenshot` works per-session.
- `CSS.getMatchedStylesForNode` returns full cascade (matched rules incl. UA origin,
  inheritance chain) — the "why is this element this color" primitive is real. A JS-side
  walker computed the effective fg/bg contrast pair (white-on-#f0f0f0) — layout-pathology
  detection is straightforward.
- `Browser.close` → process exit 0, no zombies.

## Spike 2 — `debugger-spike.mjs`: white-box debug plane (PASS)
- `Debugger.setBreakpointByUrl` on an inline handler; triggered by a real compositor
  click (`Input.dispatchMouseEvent`, fire-and-forget to avoid deadlock).
- **While paused**: `Debugger.evaluateOnCallFrame` answers (caveat below);
  `Page.captureScreenshot` of the frozen page **works**; a sibling session keeps
  executing JS completely unaffected. Pause is per-session, not per-browser.
- Resume → handler completes (`window.state` mutated as expected).
- Caveat (our bug, not protocol): breakpoint landed on the `const` declaration line, so
  the local read as `undefined` (paused before initialization). Breakpoint placement UX
  in Glassbox must resolve to the first *statement after* the target, or use
  `Debugger.getPossibleBreakpoints`.

## Spike 3 — `observation-spike.mjs`: observation economics on a real page (PASS)
Against `https://wcii.pages.dev/` (production Astro site):

| Observation | Raw size | Verdict |
|---|---|---|
| `Accessibility.getFullAXTree` | 1083 nodes, **~95,000 tokens** | NEVER inline raw |
| Distilled AXTree (role+name, ignored/generic filtered) | 263 nodes, **~1,400 tokens** | default observation, 67× compression |
| `DOMSnapshot.captureSnapshot` (5 computed styles) | ~30,000 tokens | artifact-on-disk only |
| `outerHTML` | ~11,700 tokens | artifact-on-disk only |
| Screenshot (webp q70, 1280×800) | 33 KB | cheap, use freely |
| `Page.startScreencast` (jpeg q60, 960px) | ~6 fps under motion, ~26 KB/frame | ride-along viewer is viable |

## Architectural conclusions locked in by evidence
1. **Zero-dependency raw CDP is fully viable** — no Playwright library, no
   chrome-remote-interface needed. One WebSocket, flatten-mode session multiplexing.
2. **Parallel isolated sessions are cheap** (~250ms each, memory-shared browser process).
3. **The debug plane works end to end**, including screenshots of paused pages and
   unaffected sibling sessions — a debugger session cannot starve other agents.
4. **Token discipline must be structural**: every observation tool returns distilled
   forms + a file path to the raw artifact. Raw dumps are 30–100× over budget.
