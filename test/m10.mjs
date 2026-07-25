// M10 proof: defect round 2 (the WCII dogfood, docs/defects-2026-07-24-wcii-dogfood.md).
// Like m9, every check FAILS on the pre-fix build — this is the regression floor for the round.
//
//   W1  content-visibility:auto descendants are DEFERRED, not "invisible" — one info line per
//       container, zero pathology; content-visibility:hidden stays deliberate (reported nowhere)
//   W2  `screenshot --full` forces deferred sections to paint (they stitched in as blank paper),
//       reports forcedPaint:N, restores the page exactly, and mutates nothing
//   W3  every verify labels the load state it measured (cold vs warm), warns when warm, and
//       `cold:true` really re-navigates cache-cleared — plus the executable record of the
//       cache-disable investigation (setCacheDisabled works; the favicon probe is out of reach)
//   W4  an expected-404 allowlist demotes ONLY status-404 rows, and never deletes them
//   obs the console-count labels, and the 14-tool ceiling with the new options folded in
//
// The bug zoo runs as a CHILD PROCESS (the M5/M7 deadlock lesson). Run: `node test/m10.mjs`.
process.env.GLASSBOX_SETTLE_CAP_MS = '2500';

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS, daemonReq } from '../src/protocol.mjs';
import { listGlassboxChromium } from '../src/daemon/prockit.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const SERVE = fileURLToPath(new URL('./bugzoo/serve.mjs', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args, timeout = 60000, extra = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', timeout, env: { ...process.env, GLASSBOX_NO_OPEN: '1' }, ...extra,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function readD() { try { return JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8')); } catch { return null; } }
function readReport(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function startZooProcess() {
  const child = spawn(process.execPath, [SERVE], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => { /* keep the pipe drained */ });
  const dl = Date.now() + 15000;
  while (Date.now() < dl) {
    const m = /bugzoo on (http:\/\/\S+)/.exec(out);
    if (m) return { child, base: m[1].trim(), close: () => { try { child.kill(); } catch { /* gone */ } } };
    await delay(100);
  }
  throw new Error(`bug zoo did not start: ${out.slice(0, 200)}`);
}

let zoo = null;
async function run() {
  zoo = await startZooProcess();
  const base = zoo.base;
  const counts = async () => (await fetch(base + '/counts').then((r) => r.json()).catch(() => ({})));

  cli(['kill-all']);
  await delay(500);
  check('0 precondition clean', !fs.existsSync(PATHS.daemonFile) && listGlassboxChromium().length === 0,
    `chromium ${listGlassboxChromium().length}`);

  cli(['--json', 'daemon', 'start']);
  const d = readD();
  if (!d) return check('daemon up', false, 'no daemon.json');

  const mk = (name, opts) => daemonReq(d, 'POST', '/sessions', { name, ...(opts || {}) }, 90000);
  const post = (s, verb, body, ms) => daemonReq(d, 'POST', `/sessions/${s}/${verb}`, body || {}, ms || 60000);
  const act = async (s, verb, body, ms) => (await post(s, verb, body, ms)).body;
  const goto = (s, url) => act(s, 'goto', { url }, 60000);
  const verify = (s, body) => act(s, 'verify', body || {}, 180000);
  const evalIn = async (s, expression) => (await act(s, 'eval', { expression }, 30000)).value;

  // ===== W1 — deferred is a third bucket, not invisibility =====================
  await mk('w1');
  await goto('w1', base + '/deferred.html');
  const v1 = await verify('w1', { axe: false, screenshots: false });
  const r1 = readReport(v1.artifacts?.report) || {};
  const inv = r1.layout?.invisible || [];
  const def = r1.layout?.deferred || [];
  check('W1a content-visibility:auto descendants are NOT reported as invisible interactive',
    inv.length === 0 && v1.counts.layout === 0 && v1.ok === true,
    `invisible=${inv.length} layout=${v1.counts.layout} ok=${v1.ok}`);
  check('W1b they collapse to ONE info line naming the deferred container (6 elements)',
    def.length === 1 && def[0].count === 6 && /late/.test(def[0].desc)
    && (v1.findings || []).some((f) => f.severity === 'info' && /deferred section/.test(f.summary) && /scroll to audit/.test(f.summary)),
    `deferred=${def.length} first=${def[0] ? def[0].desc + ' ×' + def[0].count : 'none'}`);
  check('W1c content-visibility:HIDDEN stays deliberate — reported nowhere',
    !/rh1|rh2|reallyhidden/.test(JSON.stringify(r1.layout || {})),
    `mentions=${(JSON.stringify(r1.layout || {}).match(/rh1|rh2|reallyhidden/g) || []).join(',') || 'none'}`);

  // ===== W2 — a full capture must paint what it stitches =======================
  const mutBefore = await evalIn('w1', 'window.__gbxMut||0');
  const blank = await act('w1', 'screenshot', { fullPage: true, forcePaint: false }, 60000);
  const painted = await act('w1', 'screenshot', { fullPage: true }, 60000);
  const mutAfter = await evalIn('w1', 'window.__gbxMut||0');
  check('W2a a full capture reports how many deferred containers it forced to paint',
    painted.forcedPaint === 1 && blank.forcedPaint === undefined,
    `painted=${painted.forcedPaint} optOut=${blank.forcedPaint}`);
  check('W2b the forced capture is a materially different image (blank regions compress to nothing)',
    painted.bytes > blank.bytes * 1.5 && painted.h !== blank.h,
    `blank=${blank.bytes}b ${blank.w}x${blank.h} → painted=${painted.bytes}b ${painted.w}x${painted.h} (${(painted.bytes / blank.bytes).toFixed(2)}x)`);
  const cvAfter = await evalIn('w1', "getComputedStyle(document.getElementById('late')).contentVisibility");
  check('W2c the page is restored exactly, and the capture mutated NOTHING (refs stay valid)',
    cvAfter === 'auto' && mutAfter === mutBefore,
    `content-visibility=${cvAfter} mutations ${mutBefore} → ${mutAfter}`);

  // ===== W3 — cold vs warm, labelled and forceable =============================
  await fetch(base + '/reset-counts').catch(() => {});
  await mk('w3');
  await goto('w3', base + '/cache.html');
  const cold1 = await verify('w3', { axe: false, screenshots: false });
  check('W3a the first load is labelled COLD, with no caveat finding',
    cold1.navigation?.kind === 'cold' && /first document load/.test(cold1.navigation?.reason || '')
    && !(cold1.findings || []).some((f) => f.channel === 'navigation'),
    `kind=${cold1.navigation?.kind} reason=${cold1.navigation?.reason}`);

  await goto('w3', base + '/cache.html');
  const warm = await verify('w3', { axe: false, screenshots: false });
  const warnLine = (warm.findings || []).find((f) => f.channel === 'navigation');
  check('W3b a repeat load is labelled WARM and carries an explicit understatement warning',
    warm.navigation?.kind === 'warm' && /2×/.test(warm.navigation?.reason || '')
    && !!warnLine && warnLine.severity === 'warn' && /CLS/.test(warnLine.summary) && /cold/i.test(warnLine.detail || ''),
    `kind=${warm.navigation?.kind} warn=${warnLine ? 'yes' : 'NO'}`);

  const beforeCold = await counts();
  const cold2 = await verify('w3', { axe: false, screenshots: false, cold: true });
  const afterCold = await counts();
  check('W3c cold:true re-navigates cache-cleared — the server really is hit again',
    cold2.navigation?.kind === 'cold' && cold2.navigation?.forced === true
    && (afterCold['style.css'] || 0) === (beforeCold['style.css'] || 0) + 1
    && !(cold2.findings || []).some((f) => f.channel === 'navigation'),
    `kind=${cold2.navigation?.kind} forced=${cold2.navigation?.forced} style.css ${beforeCold['style.css']} → ${afterCold['style.css']}`);

  // The investigation, pinned as an assertion: every navigation re-fetches a max-age=600 resource,
  // so Network.setCacheDisabled(true) IS in force — while the browser-process favicon probe is not
  // (it is fetched far fewer times than there were navigations). Both halves of the W3 answer.
  const navsSoFar = afterCold['app.js'] || 0;
  await goto('w3', base + '/cache.html');
  const afterOneMore = await counts();
  check('W3d Network.setCacheDisabled is genuinely in force (cacheable sub-resource re-fetched every load)',
    (afterOneMore['app.js'] || 0) === navsSoFar + 1 && navsSoFar >= 3,
    `app.js ${navsSoFar} → ${afterOneMore['app.js']} across ${navsSoFar + 1} loads`);
  check('W3e …while the browser-process favicon probe escapes it (fetched fewer times than loads)',
    (afterOneMore.favicon || 0) < (afterOneMore['app.js'] || 0),
    `favicon=${afterOneMore.favicon} vs app.js=${afterOneMore['app.js']} — negative-cached out of CDP's reach`);

  // ===== W4 — expected-404 allowlist ==========================================
  // The subject is the renderer-initiated /missing-404.js, not the favicon: the favicon's negative
  // result is cached BROWSER-WIDE (W3e), so a later session may never see it — which is precisely
  // why the allowlist has to be tested against something deterministic.
  await mk('w4', { ignore404: ['/missing-404.js'] });
  await goto('w4', base + '/cache.html');
  const v4 = await verify('w4', { axe: false, screenshots: false });
  const r4 = readReport(v4.artifacts?.report) || {};
  check('W4a an allowlisted 404 is demoted to an info count and stops flipping ok',
    v4.ok === true && v4.counts.netHttpError === 0 && v4.counts.ignored404 >= 2
    && (v4.findings || []).some((f) => f.severity === 'info' && /Ignored 404s/.test(f.summary)),
    `ok=${v4.ok} http=${v4.counts.netHttpError} ignored=${v4.counts.ignored404}`);
  check('W4b the demoted rows are DEMOTED, not deleted — still in the on-disk report',
    (r4.network?.ignored404 || []).length >= 1 && (r4.errors?.ignored || []).length >= 1
    && (r4.network.ignored404 || []).every((x) => x.status === 404 && x.ignoredBy === '/missing-404.js'),
    `rows=${(r4.network?.ignored404 || []).length} consoleRows=${(r4.errors?.ignored || []).length}`);

  await mk('w4b', { ignore404: ['/api/500', '/nope-404.js'] });
  await goto('w4b', base + '/errors.html');
  const v4b = await verify('w4b', { axe: false, screenshots: false });
  // Only the ACTIONABLE findings may mention the allowlisted paths — the info line naturally names
  // what it demoted, so it is excluded from this check.
  const loud = (v4b.findings || []).filter((f) => f.severity !== 'info').map((f) => f.summary).join(' | ');
  check('W4c an allowlisted path that fails with 500 still reports normally (no false all-clear)',
    v4b.ok === false && v4b.counts.netHttpError >= 1 && /api\/500/.test(loud) && !/nope-404/.test(loud),
    `ok=${v4b.ok} http=${v4b.counts.netHttpError} ignored=${v4b.counts.ignored404} loud=${loud.slice(0, 80)}`);

  // ===== observations =========================================================
  const gotoLine = cli(['goto', base + '/errors.html', '-s', 'w4b'], 60000).stdout.trim();
  check('obs1 an action delta labels its console count as MESSAGES (not the error count verify prints)',
    /\d+ console msgs? \(\d+ errors?\)/.test(gotoLine) || /\d+ console msgs?/.test(gotoLine),
    gotoLine.split('\n').pop());

  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm10', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const mcpRun = cli(['mcp'], 40000, { input: rpc });
  let tools = [];
  for (const line of mcpRun.stdout.trim().split('\n')) {
    try { const m = JSON.parse(line); if (m.id === 2) tools = m.result?.tools || []; } catch { /* not ours */ }
  }
  const props = (n) => tools.find((t) => t.name === n)?.inputSchema?.properties || {};
  check('obs2 the round-2 options are on the MCP surface, still within the 14-tool ceiling',
    tools.length === 14 && !!props('gb_verify').cold && !!props('gb_verify').ignore404
    && !!props('gb_screenshot').forcePaint && !!props('gb_session').ignore404,
    `tools=${tools.length} verify.cold=${!!props('gb_verify').cold} shot.forcePaint=${!!props('gb_screenshot').forcePaint}`);

  // ===== teardown =============================================================
  const before = listGlassboxChromium().length;
  cli(['--json', 'kill-all']);
  await delay(800);
  const after = listGlassboxChromium().length;
  check('z1 kill-all removes daemon.json', !fs.existsSync(PATHS.daemonFile));
  check('z2 kill-all leaves zero chromium orphans', after === 0, `chromium ${before} -> ${after}`);
}

function finish() {
  try { zoo?.close(); } catch { /* already gone */ }
  cli(['kill-all']);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.log('FAIL  harness threw —', e?.stack || e);
  results.push({ name: 'harness', pass: false });
}).finally(finish);
