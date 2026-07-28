// The platform seam. Everything that differs between "Glassbox on Adi's Windows box" and
// "Glassbox inside an ephemeral Linux agent container" is decided here, once, and nowhere else.
//
// Four members, per docs/01-architecture.md §11:
//   1. launcher       — which Chromium, headed or headless, and under whose X display
//   2. network policy — is outbound traffic open, or jailed behind an allowlisting proxy
//   3. human channel  — a live screencast a person can open, or an exported artifact
//   4. lifecycle      — where runtime state lives and how strays are found and reaped
//
// Only Node builtins in here: protocol.mjs imports this file and must stay cheap enough for the
// CLI and the MCP shim to load it on every invocation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

// Every glassbox-launched chromium carries its --user-data-dir in the command line; the orphan
// sweep matches on that (never a bare PID). Lives here rather than in protocol.mjs because the
// platform-specific process reapers are its only consumers.
//
// The marker used to be the bare string 'glassbox', on the assumption that the state root always
// contains it. It does not: point GLASSBOX_HOME anywhere else — which the test suite must, to avoid
// reaping a developer's real sessions — and the reaper silently matched nothing and reported zero
// strays forever. So the marker is now the ACTUAL chrome-data path, and the loose string is kept
// only as a fallback for a process whose cmdline we could not read in full.
export const CHROME_MARKER = 'glassbox';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Which platform are we
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sandbox detection, with its reasons kept. A verify report states the conditions it measured
 * under, and "sandbox" is the loudest of those conditions — so the decision has to be auditable,
 * not a boolean that appeared from nowhere. GLASSBOX_PLATFORM always wins.
 */
function detectKind() {
  const forced = (process.env.GLASSBOX_PLATFORM || '').toLowerCase();
  if (forced === 'sandbox') return { kind: 'sandbox', why: ['GLASSBOX_PLATFORM=sandbox'] };
  if (forced === 'local' || forced === 'win32' || forced === 'posix') {
    return { kind: process.platform === 'win32' ? 'win32' : 'posix', why: [`GLASSBOX_PLATFORM=${forced}`] };
  }
  if (process.platform === 'win32') return { kind: 'win32', why: ['process.platform=win32'] };

  const why = [];
  if (process.env.CCR_AGENT_PROXY_ENABLED) why.push('CCR_AGENT_PROXY_ENABLED');
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) why.push(`PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
  if (exists('/.dockerenv')) why.push('/.dockerenv');
  if (process.env.CODESPACES) why.push('CODESPACES');
  if (process.env.E2B_SANDBOX_ID) why.push('E2B_SANDBOX_ID');
  // A container without a display is the operative fact for the launcher regardless of vendor.
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) why.push('no DISPLAY');

  return why.length >= 2 ? { kind: 'sandbox', why } : { kind: 'posix', why: why.length ? why : ['process.platform=' + process.platform] };
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

const DETECTED = detectKind();

/** 'win32' | 'sandbox' | 'posix' */
export const KIND = DETECTED.kind;
export const KIND_REASONS = Object.freeze(DETECTED.why);
export const IS_SANDBOX = KIND === 'sandbox';
export const IS_WIN32 = KIND === 'win32';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Lifecycle: where runtime state lives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The state root. Short by design (MAX_PATH, research 07) and — critically — never relative.
 * The old fallback chain ended in '.', which meant the CLI, a daemon spawned with a different cwd,
 * and the test runner could each compute a different root and then disagree about where
 * daemon.json lives. A discovery file nobody can find is indistinguishable from a dead daemon.
 */
export function stateRoot() {
  if (process.env.GLASSBOX_HOME) return path.resolve(process.env.GLASSBOX_HOME);
  if (IS_WIN32) {
    const base = process.env.LOCALAPPDATA || process.env.TEMP;
    if (base) return path.join(base, 'glassbox');
    return path.join(os.homedir(), 'glassbox');
  }
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg) return path.join(xdg, 'glassbox');
  const home = os.homedir();
  // homedir() can be '/' in a stripped container; anywhere unwritable is worse than tmp.
  if (home && home !== '/' && home !== '') return path.join(home, '.glassbox');
  return path.join(os.tmpdir(), 'glassbox');
}

/** The exact --user-data-dir prefix every glassbox chromium carries. The reaper's real marker. */
export function chromeDataDir() {
  return path.join(stateRoot(), 'chrome-data');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Launcher: which Chromium, and under whose display
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find a Chromium the sandbox can actually launch.
 *
 * Playwright pins a browser revision per release; a container that ships a *different* revision
 * (this one: playwright 1.61 wants chromium-1228, the image has chromium-1194) makes
 * `channel:'chromium'` fail at launch with a "please run playwright install" error — and in a
 * sandbox with a package-registry-only allowlist, `playwright install` cannot fetch anything.
 * So we resolve a binary by path and hand it over as executablePath, which skips the registry.
 *
 * Preference order is deliberate: the full chromium build beats chromium_headless_shell, because
 * headless_shell cannot run headed under Xvfb and headed is the higher-fidelity mode here.
 */
export function findChromium() {
  if (process.env.GLASSBOX_CHROMIUM) {
    const p = process.env.GLASSBOX_CHROMIUM;
    if (exists(p)) return { path: p, why: 'GLASSBOX_CHROMIUM' };
    return { path: null, why: `GLASSBOX_CHROMIUM=${p} does not exist` };
  }
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', '/ms-playwright'].filter(Boolean);
  const found = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const e of entries) {
      const m = /^chromium(_headless_shell)?-(\d+)$/.exec(e);
      if (!m) continue;
      const rev = Number(m[2]);
      const shell = !!m[1];
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-linux/headless_shell']) {
        const p = path.join(root, e, rel);
        if (exists(p)) { found.push({ path: p, rev, shell }); break; }
      }
    }
  }
  if (found.length) {
    found.sort((a, b) => (a.shell !== b.shell ? (a.shell ? 1 : -1) : b.rev - a.rev));
    return { path: found[0].path, why: `discovered rev ${found[0].rev}${found[0].shell ? ' (headless shell)' : ''}` };
  }
  for (const bin of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try {
      const p = execFileSync('which', [bin], { encoding: 'utf8', timeout: 5000 }).trim();
      if (p && exists(p)) return { path: p, why: `which ${bin}` };
    } catch { /* keep looking */ }
  }
  return { path: null, why: 'no chromium found on disk' };
}

let CHROMIUM = null;
export function chromiumPath() {
  if (CHROMIUM === null) CHROMIUM = IS_WIN32 ? { path: null, why: 'playwright channel' } : findChromium();
  return CHROMIUM;
}

/**
 * Headed is the sandbox DEFAULT, which is the opposite of every other container browser setup.
 *
 * Measured on this image: headless reports a scrollbar width of 0px, headed-under-Xvfb reports
 * 15px — the same reserved gutter Windows Chrome gives you. A 0px scrollbar silently hides the
 * entire `100vw`-horizontal-overflow and right-edge-clipping bug class, which is exactly what a
 * layout audit exists to catch. Headless also leaves "HeadlessChrome" in the UA, which some apps
 * branch on.
 *
 * CORRECTION (2026-07-28): the cause is NOT overlay scrollbars, as this comment claimed for
 * months. Playwright appends `--hide-scrollbars` to every headless launch unconditionally
 * (playwright-core, `if (options.headless)`) so that visual comparisons are deterministic — a
 * sound default for screenshot testing and a destructive one for layout verification. Measured,
 * 800x600, page with a 100vw child:
 *
 *   headless, playwright defaults                  gutter  0px   overflow detected: no
 *   headless + ignoreDefaultArgs hide-scrollbars    gutter 15px   overflow detected: yes
 *   headed                                         gutter 15px   overflow detected: yes
 *
 * So headless was never structurally blind; `launchOptions()` was, by inheriting a flag it never
 * chose. FIXED there as of 2026-07-28 — headless now takes the flag back and measures the same
 * 15px gutter headed does, which leaves this seam standing on the UA string and GPU-dependent
 * rendering only. Those are real but much narrower than a whole bug class, so headed remains the
 * sandbox default; it is no longer load-bearing for layout correctness.
 *
 * Xvfb costs one ~30MB process. The bug class costs more than that.
 */
export function defaultHeaded() {
  if (!IS_SANDBOX) return false;
  if (process.env.GLASSBOX_HEADLESS === '1') return false;
  return hasXvfb() || !!process.env.DISPLAY;
}

export function hasXvfb() {
  try { execFileSync('which', ['Xvfb'], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
}

let XVFB = null;

/**
 * Bring up a display for headed mode, if one is needed and none exists. Returns a descriptor for
 * the conditions block, so a report can say "headed-xvfb" rather than implying a real screen.
 * Idempotent; the Xvfb child is detached so it outlives the turn that started it (a bare
 * background child is reaped at the turn boundary in this harness — see the detach note in
 * protocol.mjs).
 */
export function ensureDisplay(headed) {
  if (!headed || IS_WIN32) return { display: headed ? 'headed' : 'headless' };
  if (process.env.DISPLAY && !XVFB) return { display: 'headed', server: process.env.DISPLAY };
  if (XVFB) return { display: 'headed-xvfb', server: process.env.DISPLAY };
  if (!hasXvfb()) return { display: 'headless', downgraded: 'headed requested but no Xvfb and no DISPLAY' };

  const num = Number(process.env.GLASSBOX_XVFB_DISPLAY || 99);
  const screen = process.env.GLASSBOX_XVFB_SCREEN || '1920x1080x24';
  const sock = `/tmp/.X11-unix/X${num}`;
  if (!exists(sock)) {
    const child = spawn('Xvfb', [`:${num}`, '-screen', '0', screen, '-nolisten', 'tcp'], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !exists(sock)) { try { execFileSync('sleep', ['0.1']); } catch { /* spin */ } }
    if (!exists(sock)) return { display: 'headless', downgraded: `Xvfb :${num} did not come up within 5s` };
  }
  XVFB = { num, screen };
  process.env.DISPLAY = `:${num}`;
  return { display: 'headed-xvfb', server: `:${num}`, screen };
}

/**
 * The complete option bag for chromium.launchPersistentContext. This is the ONLY place launch
 * options are decided; sessions.mjs must not add any.
 */
export function launchOptions({ headed }) {
  const args = ['--remote-debugging-port=0'];
  const opts = { headless: !headed, args };

  // Playwright appends `--hide-scrollbars` to every headless launch, unconditionally, so that
  // visual comparisons stay deterministic across platforms with different scrollbar widths. That
  // deletes the 15px gutter BEFORE the layout audit runs, so every horizontal-overflow check
  // passes on pages that overflow — the check is fine, the evidence is gone. Take the flag back.
  // See the correction above `defaultHeaded()` for the measurement.
  //
  // The escape hatch exists because Playwright's reason is legitimate: if you are diffing
  // screenshots across machines, a scrollbar that appears on one and not another is noise. Set
  // GLASSBOX_HIDE_SCROLLBARS=1 to restore the old behaviour and accept the blind spot.
  if (!headed && process.env.GLASSBOX_HIDE_SCROLLBARS !== '1') {
    opts.ignoreDefaultArgs = ['--hide-scrollbars'];
  }

  if (IS_WIN32) {
    opts.channel = 'chromium';
    return opts;
  }

  const chrome = chromiumPath();
  if (chrome.path) opts.executablePath = chrome.path;
  else opts.channel = 'chromium';

  // /dev/shm is commonly 64MB in a container; Chromium's default shared-memory use blows through
  // it and the renderer dies with a tab crash that looks like an app bug.
  args.push('--disable-dev-shm-usage');
  // Running as uid 0 makes Chromium's own sandbox refuse to start. Only then — never blanket.
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  return opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Network policy: is outbound traffic open, or jailed
// ─────────────────────────────────────────────────────────────────────────────

const EGRESS_CANARY = process.env.GLASSBOX_EGRESS_CANARY || 'https://example.com/';
let EGRESS = null;

/**
 * Measure egress rather than assume it. An agent sandbox typically routes all traffic through an
 * allowlisting proxy that permits package registries and refuses everything else — which means a
 * page under test cannot load a web font, a CDN script, or its own API, and every one of those
 * shows up in the network taxonomy as a failure indistinguishable from a real bug.
 *
 * The verifier's job is to not lie about that, so it checks instead of guessing. Result is cached
 * for the daemon's lifetime plus persisted with a TTL, because the answer does not change often
 * and the check costs a round trip.
 */
export async function probeEgress({ ttlMs = 3600_000, cacheFile = null } = {}) {
  if (EGRESS) return EGRESS;
  if (cacheFile) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && Date.now() - c.at < ttlMs && c.state) { EGRESS = c; return EGRESS; }
    } catch { /* no cache */ }
  }
  let state = 'open';
  let detail = `${EGRESS_CANARY} reachable`;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(EGRESS_CANARY, { signal: ctl.signal, redirect: 'manual' });
    clearTimeout(t);
    if (res.status === 403 || res.status === 407) { state = 'jailed'; detail = `${EGRESS_CANARY} → ${res.status} (proxy refused)`; }
  } catch (e) {
    state = 'jailed';
    detail = `${EGRESS_CANARY} → ${String(e.cause?.code || e.name || e.message).slice(0, 60)}`;
  }
  EGRESS = { state, detail, at: Date.now() };
  if (cacheFile) {
    try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(EGRESS)); } catch { /* best effort */ }
  }
  return EGRESS;
}

/** Synchronous read of whatever probeEgress last learned; 'unknown' before the first probe. */
export function egressState() {
  return EGRESS ? EGRESS.state : 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Human channel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 'live'   — a person can open the watch URL on this machine's loopback.
 * 'export' — nobody can reach loopback here; the report has to leave as a file.
 */
export const HUMAN_CHANNEL = IS_SANDBOX ? 'export' : 'live';

// ─────────────────────────────────────────────────────────────────────────────
// Conditions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The platform half of a verify report's conditions block. A finding without its conditions is a
 * claim the instrument cannot support: "0 errors" measured with no fonts, no network and a
 * software rasterizer is not the same sentence as "0 errors" on the developer's machine.
 */
export function describePlatform() {
  const chrome = chromiumPath();
  return {
    kind: KIND,
    detectedBy: KIND_REASONS.slice(0, 4),
    browserPath: chrome.path || 'playwright channel:chromium',
    egress: egressState(),
    raster: IS_SANDBOX ? 'software' : 'gpu',
    humanChannel: HUMAN_CHANNEL,
  };
}
