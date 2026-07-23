# Research: Designing Glassbox's MCP/CLI Interface — Learning From Everyone Else's Tool Design

Date: 2026-07-23
Scope: deep tool-inventory audit of `microsoft/playwright-mcp` and `ChromeDevTools/chrome-devtools-mcp`; their GitHub-issue complaint history; MCP protocol concurrency specifics inside Claude Code; agent-facing error/self-correction design patterns; hybrid CLI+MCP precedents; token-budget response patterns. Closes with a concrete ~20-tool inventory for Glassbox.

---

## 1. TL;DR — what actually matters for Glassbox

1. **Both reference tools converged on ref-based element targeting instead of coordinates**, but they disagree on default response weight: playwright-mcp returns a fresh accessibility snapshot after nearly every action (bloat by default); chrome-devtools-mcp made snapshot-inclusion opt-in per call (`includeSnapshot: false` by default) — a direct, documented lesson in token discipline.
2. **Token bloat is the #1 complaint on both projects.** Concrete numbers exist: chrome-devtools-mcp's tool *schemas alone* cost ~17k tokens at discovery (issue #340); `list_console_message` cost 40k tokens vs. 8k copy-pasted from DevTools (#171); a 50.4k-token single response was reported as unusable (playwright-mcp #1040); Playwright's own new CLI mode cut a benchmarked task from ~114k to ~27k tokens by moving off MCP entirely.
3. **Session/context isolation for concurrent agents is a hole in both official servers**, filled by third-party forks. Chrome DevTools MCP ships `--experimentalPageIdRouting` explicitly *for* multi-agent/subagent sharing of one server instance; playwright-mcp has no first-party equivalent (`--isolated` is per-process, not per-caller) and a well-specified community feature request for named sessions was closed "not planned" — three independent forks exist purely to add per-agent isolated browser contexts.
4. **MCP `ImageContent` (base64 images) is badly punished in Claude Code specifically**: a confirmed, closed-as-not-planned bug (#31208) shows base64 screenshots returned as MCP `image` content cost 15,000–25,000 tokens versus ~1,600 tokens for the same image pasted directly into a message — a 10–20x tax, because Claude Code doesn't convert MCP `ImageContent` into a native image block reliably. **This alone argues Glassbox should return screenshots as file paths by default**, matching its own "everything on disk" hypothesis, with inline image content only as an explicit opt-in for small crops.
5. **stdio MCP servers do not share across Claude Code sessions or safely across subagents.** Each session/subagent spawning its own server process is a documented, filed root cause of a literal kernel panic (`anthropics/claude-code#45880`: 15 concurrent sessions × 34 MCP servers → 111GB+ RAM, repeated hardware watchdog panics on a 64GB Mac). Streamable HTTP is the fix pattern the ecosystem converged on — one server process, N clients — but concurrent calls into a single-threaded backend still **serialize**, they don't parallelize; only the *process* is shared, not throughput.
6. **Claude Code has hard, documented ceilings that must shape every tool's response shape**: 25,000-token default MCP output cap (configurable via `MAX_MCP_OUTPUT_TOKENS`, warning fires at 10,000), a per-tool escape hatch (`_meta["anthropic/maxResultSizeChars"]`, ceiling 500,000 chars, **text only, not images**), and automatic disk-spill-with-file-reference for anything over the threshold when the annotation isn't set.
7. **The self-correction literature converges on one shape**: never a bare error string; always `{error_code, message, field/received-value, correction_hint or "did you mean", related tools}`, returned as a normal tool result with `isError: true`, not a protocol-level JSON-RPC error — protocol errors are for "this tool doesn't exist," execution errors are for "you called it wrong," and only the latter is something the model can act on productively.
8. **Hybrid CLI+MCP-from-one-daemon is an established, actively-chosen pattern in 2026**, not a novelty: Playwright itself ships both a CLI and an MCP server off the same Playwright core specifically because they have opposite token/latency tradeoffs; Bifrost runs as "a single binary" that is simultaneously an MCP client, an MCP server, and (implicitly) operable via CLI/gateway config. This validates Glassbox's daemon-with-two-faces hypothesis directly.

---

## 2. Deep dive: `microsoft/playwright-mcp`

Source: https://github.com/microsoft/playwright-mcp (README fetched directly), cross-checked against community write-ups.

### 2.1 Full tool inventory (by category, with input shape)

**Core interaction**
- `browser_click` — `element?` (human-readable label, for permission display), `target` (exact ref like `e12`, or unique selector), `doubleClick?`, `button?`, `modifiers?`
- `browser_type` — `element?`, `target`, `text`, `submit?`, `slowly?`
- `browser_hover` — `element?`, `target`
- `browser_drag` — `startElement?`, `startTarget`, `endElement?`, `endTarget`
- `browser_drop` — `element?`, `target`, `paths?`, `data?`
- `browser_press_key` — `key`
- `browser_file_upload` — `paths?`
- `browser_fill_form` — `fields[]` (batch multi-field fill)
- `browser_select_option` — `element?`, `target`, `values[]`
- `browser_evaluate` — `element?`, `target?`, `function`, `filename?`

**Navigation / page state**
- `browser_navigate` — `url`
- `browser_navigate_back` — no params
- `browser_snapshot` — `target?`, `filename?`, `depth?`, `boxes?` (bounding boxes as `[box=x,y,w,h]` CSS px)
- `browser_take_screenshot` — `element?`, `target?`, `type`, `filename?`, `fullPage?`, `scale`
- `browser_find` — `text?`, `regex?` (search *within* the snapshot, not the DOM)
- `browser_wait_for` — `time?`, `text?`, `textGone?`
- `browser_close` — no params
- `browser_resize` — `width`, `height`

**Tabs**
- `browser_tabs` — single tool, `action` (list/create/close/select) + `index?`/`url?`

**Network (opt-in `--caps=network`)**
- `browser_network_requests` — `static`, `filter?`, `filename?`
- `browser_network_request` — `index`, `part?`, `filename?`
- `browser_route` / `browser_route_list` / `browser_unroute` — URL-pattern-based mocking with status/body/headers
- `browser_network_state_set` — toggle offline/online

**Storage (opt-in `--caps=storage`)**
- `browser_cookie_*`, `browser_localstorage_*`, `browser_sessionstorage_*` (get/list/set/delete/clear each)
- `browser_storage_state` / `browser_set_storage_state` — save/restore to a file

**PDF (opt-in `--caps=pdf`)**: `browser_pdf_save`

**DevTools/recording (opt-in `--caps=devtools`)**: `browser_highlight`, `browser_hide_highlight`, `browser_annotate`, `browser_start_tracing`/`browser_stop_tracing`, `browser_start_video`/`browser_stop_video`/`browser_video_chapter`/`browser_video_show_actions`/`browser_video_hide_actions`, `browser_resume` (`step?`, `location?` — step-through debugging)

**Vision/coordinate mode (opt-in `--caps=vision`)**: `browser_mouse_click_xy`, `browser_mouse_move_xy`, `browser_mouse_drag_xy`, `browser_mouse_down`, `browser_mouse_up`, `browser_mouse_wheel`

**Testing (opt-in `--caps=testing`)**: `browser_verify_element_visible`, `browser_verify_text_visible`, `browser_verify_value`, `browser_verify_list_visible`, `browser_generate_locator`

**Dialogs & console**: `browser_handle_dialog` (`accept`, `promptText?`), `browser_console_messages` (`level`, `all?`, `filename?`)

**Config introspection (opt-in `--caps=config`)**: `browser_get_config`

### 2.2 The ref/snapshot model

`browser_snapshot` returns a YAML-like accessibility tree — role + accessible name + an opaque `ref` per interactive node, e.g.:
```
generic [ref=e1]
  link "Skip to content" [ref=e4]
  heading "Navigation Menu" [level=2] [ref=e7]
  button "Platform" [ref=e17]
```
Every action tool then takes `target: "e17"` to act on that exact node (source: https://playwright.dev/mcp/snapshots, cross-referenced against README). **Refs are scoped to one snapshot** — stable within it, invalidated by the next navigation or DOM mutation, at which point a new snapshot issues fresh refs starting the numbering over. The `element` string parameter is *not* used for targeting; it exists purely as a human-readable label the client shows in permission-confirmation UI before the ref-targeted action fires.

### 2.3 Tabs, dialogs, downloads, network

- **Tabs**: one multiplexed tool (`browser_tabs`) rather than one tool per verb — list/create/close/select via an `action` enum.
- **Dialogs**: `browser_handle_dialog` is a dedicated tool (accept/dismiss + optional prompt text), separate from click/type — the model must explicitly resolve a dialog before other tools proceed.
- **Downloads**: notably **not a first-class concept**. No `browser_downloads_list`/`browser_download_get` tools exist upstream — feature request #154 explicitly asks for this ("files are stored in a non-accessible temporary environment"). Multiple bug reports (#355, #953, #1396) show downloads breaking across versions and modes; in `--extension` mode the CDP relay literally no-ops `Browser.setDownloadBehavior`, so `page.goto` throws `Download is starting` instead of resolving.
- **Network**: `browser_network_requests` lists everything since page load (filterable), `browser_network_request` fetches one request's full headers/body by index; `browser_route*` gives Playwright-native request mocking, gated behind `--caps=network` (not on by default — a deliberate token/scope-reduction choice).

### 2.4 Config flags worth stealing
`--isolated` (in-memory profile, nothing touches disk), `--caps=<list>` (opt-in capability groups — the mechanism that keeps the default tool list small), `--image-responses allow|omit` (global kill switch for sending screenshots back as MCP image content at all), `--snapshot-mode full|none`, `--mobile`/`--device`, `--extension` (attach to a real running Chrome/Edge via an installed extension instead of launching a fresh instance).

### 2.5 Complaints from the issue tracker
- **Token bloat, unresolved, root-caused by the author of the complaint**: issue #1040 (https://github.com/microsoft/playwright-mcp/issues/1040) — "⚠ Large MCP response (~50.4k tokens), this can fill up context quickly" on heavy pages; author proposes a less-chatty protocol plus a cache-and-reference model for DOM/page-source instead of re-transmitting it every call. No maintainer response recorded.
- **Version-over-version regression**: issue #889 (https://github.com/microsoft/playwright-mcp/issues/889) — user measured a **6x** token increase between v0.0.30 and v0.0.32 doing the identical task with vision off; requested a `verbosity: low|medium|high` knob. Left in "collecting-feedback" with no fix shipped.
- **No first-party multi-session isolation**: issue #1530 (https://github.com/microsoft/playwright-mcp/issues/1530) — a fully worked, 3,000+ line reference implementation adding `session_create/clone/save/list/switch/close/tag`, auto-detection of 50+ auth services, up to 20 concurrent sessions — **closed "not planned."** The gap it fills is real enough that at least three independent community forks exist solely to patch it: `concurrent-playwright-mcp` (session-isolated `BrowserContext`s, no cookie/storage bleed between sub-agents), `playwright-parallel-mcp` (process-per-session, "architecturally guaranteed" isolation via OS process boundaries), and an "Ultimate Playwright MCP" variant that shares one `BrowserContext` but isolates *tabs* per agent via CDP `targetId`.
- **Downloads are second-class**, see §2.3 above (#154, #355, #953, #1396) — a recurring pain point across three-plus years of issue history.
- **Profile-locking under concurrency**: Chrome/Chromium locks `user-data-dir` at the OS-process level, so two Playwright instances literally cannot share a persistent profile concurrently — the documented workaround is "run each additional client with `--isolated` or a distinct `--user-data-dir`," which is a process-count answer to what is fundamentally a session-scoping problem.

---

## 3. Deep dive: `ChromeDevTools/chrome-devtools-mcp`

Source: https://github.com/ChromeDevTools/chrome-devtools-mcp and its `docs/tool-reference.md` (both fetched directly).

### 3.1 Full tool inventory (52 tools across 10 categories)

**Input automation (10)**: `click` (`uid`, `dblClick?`, `includeSnapshot?`), `drag` (`from_uid`, `to_uid`, `includeSnapshot?`), `fill` (`uid`, `value`, `includeSnapshot?`), `fill_form` (`elements[]`, `includeSnapshot?`), `handle_dialog` (`action: accept|dismiss`, `promptText?`), `hover` (`uid`, `includeSnapshot?`), `press_key` (`key`, `includeSnapshot?`), `type_text` (`text`, `submitKey?`), `upload_file` (`filePath`, `uid`, `includeSnapshot?`), `click_at` (`x`, `y`, `dblClick?`, `includeSnapshot?` — requires `--experimentalVision`)

**Navigation (6)**: `close_page` (`pageId`), `list_pages` (none), `navigate_page` (`type: url|back|forward|reload`, `url?`, `timeout?`, `ignoreCache?`, `initScript?`, `handleBeforeUnload?`), `new_page` (`url`, `background?`, `isolatedContext?`, `timeout?`), `select_page` (`pageId`, `bringToFront?`), `wait_for` (`text[]`, `timeout?`)

**Emulation (2)**: `emulate` (`colorScheme?`, `cpuThrottlingRate?`, `extraHttpHeaders?`, `geolocation?`, `networkConditions?` preset enum, `userAgent?`, `viewport?` — `WxHxDPR` string with mobile/touch/landscape flags), `resize_page` (`width`, `height`)

**Performance (3)**: `performance_start_trace` (`autoStop?`, `filePath?`, `reload?`), `performance_stop_trace` (`filePath?`), `performance_analyze_insight` (`insightName`, `insightSetId`)

**Network (2)**: `list_network_requests` (`includePreservedRequests?`, `pageIdx?`, `pageSize?`, `resourceTypes[]?`), `get_network_request` (`reqid?`, `requestFilePath?`, `responseFilePath?`)

**Debugging (8)**: `evaluate_script` (`function`, `args?`, `dialogAction?`, `filePath?`), `list_console_messages` (`includePreservedMessages?`, `pageIdx?`, `pageSize?`, `serviceWorkerId?`, `types[]?`), `get_console_message` (`msgid`), `lighthouse_audit` (`device?`, `mode: navigation|snapshot`, `outputDirPath?`), `take_screenshot` (`filePath?`, `format?`, `fullPage?`, `quality?`, `uid?`), `take_snapshot` (`filePath?`, `verbose?`), `screencast_start`/`screencast_stop` (needs ffmpeg)

**Memory (12)**: full heap-snapshot toolkit — `take_heapsnapshot`, `close_heapsnapshot`, `compare_heapsnapshots` (`baseFilePath`, `currentFilePath`, `classIndex?`), plus `get_heapsnapshot_{class_nodes,details,dominators,duplicate_strings,edges,object_details,retainers,retaining_paths,summary}`, all paginated with `pageIdx`/`pageSize`.

**Extensions (5)**: `install_extension`, `list_extensions`, `reload_extension`, `trigger_extension_action`, `uninstall_extension` — all keyed on an `id`/`path`.

**Third-party & WebMCP (4)**: `execute_3p_developer_tool`/`list_3p_developer_tools`, `execute_webmcp_tool`/`list_webmcp_tools` — a meta-layer letting the server proxy *other* tool ecosystems (including page-embedded "WebMCP" tools the site itself exposes).

### 3.2 The `uid`/snapshot model — and its key design difference from playwright-mcp
`take_snapshot` produces the accessibility tree, each element gets a `uid`, and other tools consume it the same way playwright-mcp consumes `ref`. **The critical difference**: every input/navigation tool has an `includeSnapshot` param that **defaults to `false`**. Instead of auto-attaching a fresh full-tree snapshot to every action's response (playwright-mcp's behavior, and its principal complaint source), chrome-devtools-mcp forces the caller to explicitly ask for a snapshot when it actually needs one. Issue #578 (https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/578) codifies the intended usage pattern explicitly: *"You should use the UIDs from the most recently returned snapshot, not from a manually taken snapshot. Taking manual snapshots too frequently will cause UIDs to go stale."* — i.e., let the tool call's own returned snapshot (if requested) be the source of truth, don't poll `take_snapshot` speculatively.

### 3.3 Network, console, performance, emulation
- Network and console tools are both **paginated** (`pageIdx`/`pageSize`) and support an `includePreservedRequests`/`includePreservedMessages` flag to reach back across the last 3 navigations — a deliberate answer to "the log resets on every navigate and the agent loses history it needed."
- Console messages carry **source-mapped stack traces**.
- Performance tracing integrates with Chrome's own Insights model (`performance_analyze_insight` takes named insights like `"LCPBreakdown"`) and by default phones home to Google's CrUX API for real-user comparison data unless `--no-performance-crux` is set — a privacy/network-egress detail worth flagging for any tool that reaches outside localhost.
- `emulate` is one consolidated tool for viewport + network throttling + CPU throttling + geolocation + color-scheme + UA override, rather than five separate tools — a direct instance of the "consolidate related operations" principle (§5.1).

### 3.4 Config flags worth stealing
`--headless`, `--channel canary|dev|beta|stable`, `--isolated` (temp profile, auto-cleaned on close), `--viewport WxH`, `--browser-url` / `--wsEndpoint` (attach to an already-running Chrome via CDP instead of launching one), `--autoConnect` (auto-attach to Chrome 144+ already running locally), **`--experimentalPageIdRouting`** (see §4.3 — the first-party answer to multi-agent sharing), `--redactNetworkHeaders`, `--screenshotFormat/Quality/MaxWidth/MaxHeight`.

### 3.5 Complaints from the issue tracker
- **Tool-schema cost at discovery time**: issue #340 (https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/340) — the server's tool *definitions alone* cost ~17,000 tokens before a single call is made, over two-thirds of a commonly-cited context budget for tool discovery.
- **Snapshot noise**: issue #635 (https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/635) — a large fraction of the accessibility tree consists of `role: ignored` nodes carrying no semantic value to an LLM but still serialized into every snapshot, "dramatically" inflating tokens and latency.
- **Console log verbosity**: issue #171 (https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/171) — `list_console_message` cost **40k tokens** for output a human would get in **8k tokens** by literally copy-pasting from DevTools.
- **Onboarding friction burns tokens too**: issue #578 — in ~30% of sessions, agents "had difficulty figuring out the right usage pattern at the beginning," itself burning tokens on trial-and-error before productive work started — an argument for putting usage guidance in MCP *server instructions* (used for tool-search relevance in Claude Code, see §4.5), not just per-tool descriptions.
- **Process/session conflicts**: issue #1763 (https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1763) — reconnects (e.g. `/mcp` in Claude Code) spawn a *new* server process without killing the old one; both fight over the same CDP debug port and `Network.enable` times out. Root cause quoted directly: *"There's no mechanism to prevent or clean up duplicate connections to the same browser endpoint."* Fix in flight (#1761): endpoint-scoped PID lock files that detect and kill the stale instance before acquiring the lock.
- **Single-browser-instance architecture**: issue #926 (https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/926) — "the current MCP server binds to a single Chrome instance for its entire lifetime," blocking any of: parallel-source research, multi-user/auth-state comparison testing, or CI parallel test runs, from one server. Proposed API (`create_session`/`list_sessions`/`close_session` + optional `sessionId` on every existing tool) mirrors playwright-mcp's #1530 almost exactly — this is a convergent, cross-project gap, not one team's oversight.
- **Long-running reliability**: issue #1094 — over long coding-agent sessions with `--autoConnect`, tool calls start failing with transport errors even while Chrome remote debugging is still up, and the MCP process appears to restart on its own.

---

## 4. MCP protocol concurrency, specifically inside Claude Code

### 4.1 stdio vs. streamable HTTP — the tradeoff that matters for a daemon design
Per the MCP spec (https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) and corroborating write-ups: **stdio is strictly 1 process : 1 connection** — the client launches the server as a subprocess and owns its stdin/stdout exclusively. **Streamable HTTP lets one server process serve many clients**, each optionally tracked by a server-issued `Mcp-Session-Id` header the client must echo on every subsequent request; the server chooses stateless (each request independent, good for serverless) or stateful (session persists, good for caching/multi-step workflows) operation per its own design (source: MCP spec transports page + `modelcontextprotocol/modelcontextprotocol` discussion #1677).

### 4.2 The concrete failure mode that makes this non-academic
`anthropics/claude-code` issue #45880 (https://github.com/anthropics/claude-code/issues/45880): running N concurrent Claude Code sessions against M configured stdio MCP servers spawns up to **N×M unbounded node processes** — no memory cap, no cleanup on session end, no cgroups on macOS. Concretely: 12 sessions + 308 node processes → 111GB RAM → kernel panic (April 2026 incident); 15 sessions + 34 servers → repeated hardware-watchdog panics **twice in one evening** on a 64GB MacBook Pro. Proposed mitigations in the thread: cap child-process heap via `NODE_OPTIONS=--max-old-space-size=256`, share server *instances* across sessions instead of spawning per-session, and lazy-start servers only when a tool from them is actually invoked rather than at session boot.

### 4.3 Does sharing a process buy you parallelism? No — and this matters for Glassbox's browser workload
The Codex-over-Claude-Code writeup (https://zenn.dev/lv/articles/3127b6ee6fe8ed) is explicit about the limit of the streamable-HTTP fix: wrapping a stdio server (via `supergateway`) in an HTTP façade stops the *process*-count explosion, but "even if 10 parallel Tasks send requests simultaneously, the underlying [server] process is single, so requests are effectively serialized." **Sharing a connection is not the same as sharing capacity.** This is exactly the gap chrome-devtools-mcp's `--experimentalPageIdRouting` flag targets directly: the README frames it as *for* the case where "your client shares a single server instance across concurrent agents or subagents" — it exposes `pageId` on every page-scoped tool so each caller can route its calls to the specific tab/session it owns, turning one shared connection into N logically-independent lanes instead of one serialized queue. This is the closest first-party precedent to Glassbox's "named parallel isolated sessions" hypothesis, and it exists *because* the community forks (concurrent-playwright-mcp, playwright-parallel-mcp — see §2.5) already proved the demand.

### 4.4 How subagents actually connect (Claude Code specifics)
Per Claude Code's sub-agent docs (cross-referenced via search, not directly quotable at full fidelity here): a subagent that references an MCP server **by name** (string reference) reuses the parent session's already-established connection; a subagent that defines an MCP server **inline** in its own config gets a fresh connection created at subagent start and torn down at subagent end. Separately, per the official MCP reference doc (`code.claude.com/docs/en/mcp`, fetched directly): MCP tool calls made **from a subagent are never automatically backgrounded** — only main-conversation calls move to a background task after 2 minutes; subagent calls block until they finish. Practical read for Glassbox: if multiple subagents are each driving their own named browser session through one shared Glassbox daemon connection, a slow tool call from one subagent does not get silently deferred by Claude Code's own scheduler — the daemon itself must not let one caller's slow action stall another caller's fast one, reinforcing that per-session routing (à la `--experimentalPageIdRouting`) has to happen *inside* Glassbox, not be assumed away by the client.

### 4.5 Concurrent calls on a single stdio connection are fragile in practice
Independent of Claude Code, general MCP ecosystem reports (fastmcp issue #1625, python-sdk issue #824) describe real breakage under naive concurrent stdio use: stream contention errors ("stream is currently in use by a previous operation"), and worse, silent protocol corruption when concurrent writes race on `process.stdout.write`, which the SDK then misreports as "connection closed." **Design implication**: if Glassbox's daemon is reached over stdio by multiple callers (even indirectly, via a client-side multiplexer), don't assume JSON-RPC's request-ID field alone makes concurrent calls safe in practice — either serialize writes at the transport layer explicitly, or make streamable HTTP with per-session routing the primary interface and treat stdio as a single-caller convenience wrapper on top of it.

### 4.6 Tool-result size limits and image handling in Claude Code (load-bearing for Glassbox's output design)
All of the following is from `code.claude.com/docs/en/mcp`, fetched directly (2026 version), and is Claude-Code-specific, not MCP-spec-general:
- Default max MCP tool output: **25,000 tokens**; warning fires at **10,000 tokens** (fixed threshold, doesn't move even if you raise the cap).
- Raise the cap globally via `MAX_MCP_OUTPUT_TOKENS` env var.
- A server can raise the cap **per-tool** via `_meta["anthropic/maxResultSizeChars"]` in that tool's `tools/list` entry, up to a **500,000-character hard ceiling** — but this only affects **text** content; **tools returning image data are still bound by `MAX_MCP_OUTPUT_TOKENS`, full stop, with no per-tool override.**
- Anything over the applicable threshold that isn't explicitly annotated gets **persisted to disk automatically and replaced with a file reference** in the conversation — i.e. Claude Code itself already implements Glassbox's "artifacts on disk" instinct as a fallback behavior when a tool doesn't do it deliberately.
- **Tool search / deferred loading** is on by default in current Claude Code: MCP tool *definitions* are not loaded into context at session start — only names and server *instructions* are, and Claude searches for and loads the specific tool schema when a task needs it. A server's `instructions` field (analogous to a skill description) is what teaches the tool-search step when to reach for your tools at all; both tool descriptions and server instructions are hard-truncated at 2KB, so front-load the important part. `alwaysLoad: true` (per-server or per-tool via `"anthropic/alwaysLoad": true`) exempts a small, always-needed tool set from deferral, at the cost of it always consuming context and blocking session startup until connected (5s timeout).
- **The `ImageContent` tax** (`anthropics/claude-code#31208`, confirmed, closed-as-not-planned): an MCP server returning `{type: "image", data: base64, mimeType}` should, per spec, become a native Claude image block; in practice Claude Code frequently treats it as raw text, costing **15,000–25,000 tokens per image** versus **~1,600 tokens** for the same image attached directly to a user message — a **10–20x** penalty, and it can outright blow the 25k default ceiling on a single screenshot (reported failure: a 62,162-character base64 payload rejected outright). Named-affected servers in the issue: Jupyter MCP (matplotlib charts), **Playwright** (screenshots), Figma. Workarounds the issue itself surfaces: return a **file path** instead of inline image content, or use MCP's **`resource_link`** content type (a URI the client can fetch/subscribe to on demand) rather than embedding the bytes in the tool result at all.

---

## 5. Interface design patterns for agent self-correction and token budget

### 5.1 Anthropic's own guidance for tools built for Claude (`anthropic.com/engineering/writing-tools-for-agents`)
- **Consolidate, don't enumerate CRUD**: "Instead of implementing `list_users`, `list_events`, and `create_event` tools, consider implementing a `schedule_event` tool which finds availability and schedules an event." Fewer, higher-level tools beat many thin ones.
- **Namespace by service and resource**: `asana_search`, `asana_projects_search` — prefixing keeps tool boundaries legible once a session has many servers loaded.
- **Return high-signal fields, not raw identifiers**: prefer `name`/`file_type`/`image_url` over bare `uuid`/`mime_type` — "resolving arbitrary alphanumeric UUIDs to more semantically meaningful and interpretable language... significantly improves Claude's precision in retrieval tasks."
- **Response-format control as a first-class parameter**: an explicit `response_format: "concise" | "detailed"` enum, with concrete measured numbers in Anthropic's own example (72 tokens concise vs. 206 tokens detailed) — concise mode returns IDs sufficient for a follow-up call, detailed mode returns everything, and the *caller* decides which it needs.
- **Pagination/truncation must come with actionable guidance**, not a silent cutoff: the example given tells the agent to "search using more targeted queries" rather than just returning a truncated blob and going quiet about it.

### 5.2 Structured error taxonomy and the "did you mean" pattern
Convergent across multiple independent write-ups (alpic.ai; dev.to "MCP Tool Design"; ChatForest MCP error-handling guide):
- **Two error classes, handled completely differently**: MCP *protocol* errors (unknown tool, malformed JSON, no such method) are JSON-RPC-level failures the client — not the model — should generally handle. *Tool execution* errors (input was wrong shape, resource didn't exist, precondition unmet) must be returned as a **normal successful tool result** with `isError: true` and a natural-language `text` explaining what went wrong — this is what actually reaches the model's context and can be acted on.
- **Concrete before/after pattern** (alpic.ai, quoted directly):
  - Bad: generic `"An error occurred"`.
  - Good, ordering guidance: `"You can't terminate an instance in the running state. Use the stop_instance tool first."`
  - Good, value correction / did-you-mean: `"The requested travel date cannot be set in the past... Did you mean July 31st, 2025 instead?"`
  - Good, retry strategy: explicit guidance on whether to retry immediately, back off, or escalate to a human after N attempts.
- **The "available options" pattern**: on a hallucinated/invalid enum or reference value (e.g. a bad table name, a stale ref), returning the **list of currently valid values** alongside the error turns a hallucination into a correctable next call instead of a dead end — reported as one of the single highest-leverage patterns for reducing agent round-trips.
- **Recommended JSON shape** (synthesized across sources, not any one spec): `{error_code, message, field, received_value?, correction_hint, related_tools?}` with a small closed taxonomy (`VALIDATION_FAILED`, `RESOURCE_NOT_FOUND`, `PERMISSION_DENIED`, `RATE_LIMIT_EXCEEDED`, `INVALID_STATE`) rather than open-ended strings — lets a client render consistent recovery UI *and* lets the model pattern-match on the code, not just parse prose.

### 5.3 Hybrid CLI+MCP-from-one-daemon precedents
- **Playwright itself, 2026**: Microsoft ships *both* Playwright MCP (keeps a live browser + full accessibility snapshot resident in the model's context — suited to long, stateful autonomous loops) *and* a newer Playwright CLI (each action is a shell command, artifacts go to disk, no persistent snapshot in context — suited to short, token-conscious coding-agent tasks). Both share the same underlying Playwright core; they're marketed as two *deliberately different* interfaces to the same automation engine, chosen per workload, not one deprecating the other. Independent benchmark: ~114k tokens for a task over MCP vs. ~27k over CLI for the identical task (scrolltest.medium.com, cross-referenced against testdino.com's "avoid loading large tool schemas and verbose accessibility trees into context" framing of *why*).
- **Bifrost**: "a single binary" operating simultaneously as an MCP client (talks to upstream tool servers) and an MCP server (exposes an aggregated tool surface to Claude Code/Cursor/Claude Desktop via one `/mcp` endpoint) — i.e., one daemon, multiple protocol faces, which is structurally the same shape Glassbox needs (daemon owns the browser; CLI and MCP are both just clients of it).
- **General pattern name in circulation**: "Dual-Interface architecture" — explicitly recommended in 2026 tooling commentary as the default shape for anything meant to be driven by both a human at a terminal and an agent through MCP, on the reasoning that the two audiences have opposite token/latency/ergonomics needs from what is otherwise the identical underlying action.

### 5.4 Token-budget response patterns actually seen in the wild
- **Diff-based responses**: `mcp-server-macos-use` exposes a `showDiff` flag on click/type/press/scroll — it snapshots the accessibility tree before and after the action, subtracts, drops scrollbar noise and empty structural containers, and returns a flat `+`/`-`/`~` diff instead of the full tree. `agent-browser`'s diffing mode does the same for Playwright-style snapshots, emitting unified-diff-style lines (`+ button "Submit" [ref=e2] [disabled]`) plus a summary tally (`"3 additions, 2 removals, 41 unchanged"`), and separately supports pixel-diff screenshots reporting exact changed-pixel counts and percentages.
- **Disk-spill-with-preview**: for any response that would blow past a token budget, the pattern observed both informally (community "token-budgeting proxy" wrapping playwright-mcp: full fidelity written to disk, an ~8k-token preview plus the file path returned inline) and formally (Claude Code's own automatic behavior described in §4.6) is the same: **never silently truncate content the agent didn't ask to truncate** — write the full artifact to disk, return a bounded preview plus the path, let the agent `Read` more if it actually needs to.
- **Capped lists with pagination, not silent limits**: chrome-devtools-mcp's `pageIdx`/`pageSize` pattern on `list_network_requests`, `list_console_messages`, and every heap-snapshot list tool is the concrete implementation of "truncation with sensible defaults" from Anthropic's guidance (§5.1) — plus an `includePreservedRequests`/`includePreservedMessages` escape hatch so history isn't silently lost across a navigation the agent didn't realize would reset the log. MCP's own spec-level pagination (`tools/list` `cursor`/`nextCursor`) is the same shape at the protocol layer.

---

## 6. Recommended tool inventory for Glassbox (~20 tools)

Design principles drawn directly from §§2–5: (a) lean-by-default responses, snapshot/screenshot inclusion opt-in per call, mirroring chrome-devtools-mcp's `includeSnapshot` over playwright-mcp's always-attach; (b) every ref/uid is explicitly scoped to a **named session** from creation, closing the gap both upstream projects left to community forks; (c) screenshots and other artifacts return **file paths** by default, never inline base64, given the confirmed 10–20x Claude Code tax; (d) every error is a structured, tool-execution-level result with a correction hint and, where applicable, the current valid-value list; (e) list-shaped tools are paginated from day one, not retrofitted.

**Session lifecycle**
1. `session_open` — `{name, url?, viewport?, colorScheme?, deviceProfile?}` → `{sessionId, name}`. Named, isolated `BrowserContext` per session (like the closed-not-planned playwright-mcp #1530 proposal, but shipped).
2. `session_list` — `{}` → `[{sessionId, name, url, createdAt, tabCount}]`.
3. `session_close` — `{sessionId}` → `{closed: true}`.
4. `session_watch` — `{sessionId, on: boolean}` → toggles a human-visible (headed/CDP-inspector-attached) ride-along view for that one session without affecting others.

**Navigation & tabs**
5. `navigate` — `{sessionId, url, waitUntil?}` → `{tabId, finalUrl, status}`.
6. `tabs_list` / `tab_select` / `tab_close` — `{sessionId, tabId?}`, mirroring playwright-mcp's single-multiplexed-`browser_tabs`-tool shape rather than 3 separate schemas where reasonable.

**Snapshot / element targeting**
7. `snapshot` — `{sessionId, tabId?, depth?, includeIgnored?: false}` → ref-tree text, ref format `s<session-ordinal>-e<n>` so refs are unambiguous even if a transcript interleaves two sessions. `includeIgnored` defaults false per chrome-devtools-mcp issue #635's lesson.
8. `snapshot_diff` — `{sessionId, sinceRef?}` → the `+/-/~` diff pattern from §5.4, for "what changed after my last action" without a full re-dump.
9. `find` — `{sessionId, text?, regex?, role?}` → matches within the *last* snapshot (mirrors playwright-mcp `browser_find`), avoids forcing a fresh full snapshot just to locate one element.

**Interaction** (each takes `includeSnapshot?: false` and returns only a short outcome line unless the caller opts in — the chrome-devtools-mcp lesson applied uniformly)
10. `click` — `{sessionId, ref, button?, doubleClick?}`
11. `type` — `{sessionId, ref, text, submit?}`
12. `fill_form` — `{sessionId, fields: [{ref, value}]}` (batched, per §5.1 consolidation)
13. `press_key` — `{sessionId, key}`
14. `select_option` — `{sessionId, ref, values[]}`
15. `handle_dialog` — `{sessionId, action: "accept"|"dismiss", promptText?}`

**Verification bundle (the core "one-call verify" hypothesis)**
16. `verify` — `{sessionId, tabId?, checks: ["console","network","a11y","layout","screenshot"][]}` → one structured object with a section per requested check, each independently paginated/truncated, each artifact (screenshot, full network HAR, full a11y audit) written to disk with a path plus an inline summary. This is the tool that stands in for stitching together `browser_console_messages` + `browser_network_requests` + `browser_take_screenshot` + an axe-core-style audit by hand every time, per Anthropic's consolidation guidance (§5.1).
17. `screenshot` — `{sessionId, tabId?, ref?, fullPage?, format?}` → `{path, width, height}` — **file path only**, no inline base64 by default (§4.6's `#31208` finding); an explicit `inline: true` opt-in returns a small (e.g. viewport-cropped, downscaled) MCP `image` block for genuinely quick visual checks where the token cost is acceptable.

**Console & network**
18. `console_messages` — `{sessionId, tabId?, types?, pageIdx?, pageSize?, sinceNavigation?}` → paginated, with the "reach back across navigations" escape hatch from chrome-devtools-mcp §3.3.
19. `network_requests` — `{sessionId, tabId?, filter?, resourceTypes?, pageIdx?, pageSize?}` → summaries; full headers/body only via:
20. `network_request` — `{sessionId, requestId}` → full detail, response body written to disk above a size threshold rather than inlined.

**White-box debugging**
21. `evaluate` — `{sessionId, tabId?, function, args?}` → JS execution, output size-limited with `_meta["anthropic/maxResultSizeChars"]` set generously for this one tool per Claude Code's own escape hatch (§4.6), since debugging output is often legitimately large and structured.
22. `breakpoint_set` / `breakpoint_clear` — `{sessionId, tabId?, url, line, condition?}` — white-box hook the two reference tools don't offer at all; this is Glassbox's actual differentiator per the original hypothesis.
23. `coverage_start` / `coverage_stop` — `{sessionId, tabId?}` → JS/CSS coverage report path, same disk-first pattern as `verify`.

**Self-correction / discoverability**
24. `list_actions` — `{sessionId}` → the current valid ref list plus tab list; intended as the **explicit target of a "did you mean"** error's `correction_hint` (§5.2) — e.g. a `click` on a stale ref returns `{error_code: "STALE_REF", correction_hint: "ref e17 is from a snapshot before the last navigation; call list_actions or snapshot to get current refs", available_refs: [...]}` rather than a bare Playwright exception.

Every error from every tool above follows the §5.2 shape: `{error_code, message, field?, received_value?, correction_hint, related_tools?}`, delivered as `isError: true` tool content, never a raw stack trace.

---

## 7. Sources

- https://github.com/microsoft/playwright-mcp (README, tool list, config flags)
- https://playwright.dev/mcp/snapshots (accessibility snapshot ref format, worked example)
- https://playwright.dev/docs/getting-started-mcp
- https://github.com/microsoft/playwright-mcp/issues/1040 (50.4k-token response complaint)
- https://github.com/microsoft/playwright-mcp/issues/889 (6x token regression 0.0.30→0.0.32)
- https://github.com/microsoft/playwright-mcp/issues/1530 (named session management, closed not planned)
- https://github.com/microsoft/playwright-mcp/issues/154 (download discovery/retrieval feature request)
- https://github.com/microsoft/playwright-mcp/issues/355 (browser_click download regression ≥0.0.19)
- https://github.com/microsoft/playwright-mcp/issues/1396 (downloads fail in --extension mode, CDP relay no-ops Browser.setDownloadBehavior)
- https://github.com/microsoft/playwright-mcp/issues/953 (CSV download filename/path bug)
- https://github.com/ChromeDevTools/chrome-devtools-mcp (README)
- https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md (full parameter tables)
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/926 (single-Chrome-instance architecture, multi-session feature request)
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1763 (duplicate connections, Network.enable timeout, PID lock fix)
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/578 (uid staleness, usage-pattern friction ~30% of sessions)
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/635 (ignored-node snapshot bloat)
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/340 (~17k token tool-schema discovery cost)
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/171 (list_console_message 40k vs 8k tokens)
- https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1094 (long-running --autoConnect transport failures)
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools (tool result content types, image/audio/resource_link/structured content, error handling model)
- https://modelcontextprotocol.io/specification/2025-03-26/basic/transports (stdio vs streamable HTTP, Mcp-Session-Id)
- https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1677 (multiple clients on one streamable HTTP server)
- https://code.claude.com/docs/en/mcp (transport config, scopes, MAX_MCP_OUTPUT_TOKENS, anthropic/maxResultSizeChars, tool search / alwaysLoad, subagent backgrounding behavior, elicitation, resources)
- https://github.com/anthropics/claude-code/issues/45880 (kernel panic from N sessions × M MCP servers)
- https://github.com/anthropics/claude-code/issues/31208 (MCP ImageContent 10–20x token tax, confirmed, closed not planned)
- https://zenn.dev/lv/articles/3127b6ee6fe8ed (stdio→streamable HTTP fix for Claude Code subagent process proliferation; concurrency ≠ parallelism caveat)
- https://www.anthropic.com/engineering/writing-tools-for-agents (tool consolidation, namespacing, high-signal fields, response_format enum, pagination/truncation guidance)
- https://alpic.ai/blog/better-mcp-tool-call-error-responses-ai-recover-gracefully (structured error taxonomy, isError shape, before/after error examples)
- https://agent-browser.dev/diffing (diff-based snapshot/screenshot response format)
- https://scrolltest.medium.com/playwright-mcp-burns-114k-tokens-per-test-the-new-cli-uses-27k-heres-when-to-use-each-65dabeaac7a0 (MCP vs CLI token benchmark)
- https://testdino.com/blog/playwright-cli-vs-mcp (why CLI is cheaper: no resident schemas/snapshots in context)
- https://www.getmaxim.ai/articles/5-best-mcp-gateways-for-developers-in-2026-2/ (Bifrost single-binary dual MCP client/server)
