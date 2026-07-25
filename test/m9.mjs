// M9 proof: defect round 1 (the DegreeForge dogfood, docs/defects-2026-07-24-degreeforge-dogfood.md).
// Every check here FAILS on the pre-fix build — that is the point of a regression suite: each one
// pins the exact behaviour a real QA pass caught the tool lying about.
//
//   D1  act click refuses a target a real pointer cannot reach (ACT_OCCLUDED), --force is explicit
//   D2  the theme sweep RELOADS per leg (boot-time theme readers), identical shots are a finding
//   D3  themeClass drives Tailwind's darkMode:['class']
//   D4  an open modal collapses its backdrop occlusions into one info line
//   D5  a visibility:hidden ANCESTOR is one grouped finding, not one per descendant
//   D6  debug listeners echoes the inspected node, warns on N>1, finds delegated ancestors
//   D7  wait --url '/path' matches the PATHNAME (and does not false-match a partial segment)
//   D8  session open prints the watch URL
//   D9  sweep artifacts are named by the axis actually swept
//   D10 a plain sleep owns its own budget and always succeeds
//   D11 an existing session can be resized — inside gb_session, keeping the 14-tool ceiling
//   plus the two cheap dogfood observations (consoleErrors label, scroll already-in-view)
//
// The bug zoo runs as a CHILD PROCESS: this proof mixes spawnSync CLI calls with live page traffic,
// and spawnSync blocks the event loop an in-process server would need (the M5/M7 deadlock lesson).
// Run: `node test/m9.mjs`.
process.env.GLASSBOX_SETTLE_CAP_MS = '2500';

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS, CODES, HTTP_STATUS, daemonReq } from '../src/protocol.mjs';
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

  cli(['kill-all']);
  await delay(500);
  check('0 precondition clean', !fs.existsSync(PATHS.daemonFile) && listGlassboxChromium().length === 0,
    `chromium ${listGlassboxChromium().length}`);

  // ---- D8 rides on the very first session open (CLI, human-readable) ----------
  const opened = cli(['session', 'open', 'd1']);
  const d = readD();
  check('D8 `session open` prints the promised watch URL',
    opened.status === 0 && /watch:\s*http:\/\/127\.0\.0\.1:\d+\/watch\/d1\?token=[0-9a-f]{8}/.test(opened.stdout),
    opened.stdout.trim().split('\n').pop());
  if (!d) return check('daemon up', false, 'no daemon.json');

  const post = (s, verb, body, ms) => daemonReq(d, 'POST', `/sessions/${s}/${verb}`, body || {}, ms);
  const act = async (s, verb, body, ms) => (await post(s, verb, body, ms)).body;
  const goto = (s, url) => act(s, 'goto', { url }, 60000);
  const verify = (s, body) => act(s, 'verify', body || {}, 180000);
  const dbg = (s, body, ms = 60000) => act(s, 'debug', body, ms);
  const evalIn = async (s, expression) => (await act(s, 'eval', { expression }, 30000)).value;

  // ===== D1 — a click a real pointer cannot make ==============================
  await goto('d1', base + '/occlusion.html');
  const occluded = await post('d1', 'click', { selector: '#zoomin' }, 30000);
  const oe = occluded.body?.error || {};
  check('D1a click on a covered control fails with a structured ACT_OCCLUDED naming the coverer',
    occluded.status === HTTP_STATUS.ACT_OCCLUDED && oe.code === CODES.ACT_OCCLUDED
    && /legend/.test(oe.occludedBy || '') && /force/.test(oe.correction_hint || ''),
    `status=${occluded.status} code=${oe.code} occludedBy=${oe.occludedBy}`);

  const titleAfterRefusal = await evalIn('d1', 'document.title');
  check('D1b the refused click really did NOT happen (page state untouched)',
    !/clicked/.test(String(titleAfterRefusal)), `title=${JSON.stringify(titleAfterRefusal)}`);

  const forced = await act('d1', 'click', { selector: '#zoomin', force: true }, 30000);
  check('D1c --force performs it AND stamps forced:true + occludedBy into the delta',
    forced.ok === true && forced.forced === true && /legend/.test(forced.occludedBy || ''),
    `forced=${forced.forced} occludedBy=${forced.occludedBy}`);

  const clear = await act('d1', 'click', { selector: '#free' }, 30000);
  check('D1d an unobstructed click is unaffected (no forced flag, click lands)',
    clear.ok === true && clear.forced === undefined && /clicked:free/.test(String(await evalIn('d1', 'document.title'))),
    `forced=${clear.forced}`);

  // ===== D2 — the sweep must reload, and say when both legs look identical =====
  await goto('d1', base + '/boot-theme.html');
  const vBoot = await verify('d1', { themes: true, axe: false });
  const repBoot = readReport(vBoot.artifacts?.report) || {};
  const darkOnly = (repBoot.sweep || []).some((f) => String(f.combo).startsWith('dark') && /contrast/i.test(f.summary) && /note/.test(f.summary));
  check('D2a a boot-time theme reader is swept correctly (dark-only bug caught via the per-leg reload)',
    darkOnly && vBoot.ok === false,
    `ok=${vBoot.ok} sweep=${(repBoot.sweep || []).map((f) => f.combo + ':' + f.summary.slice(0, 24)).join(' | ') || 'none'}`);

  const shotNames = (vBoot.artifacts?.screenshots || []).map((p) => path.basename(p));
  const bytes = (vBoot.artifacts?.screenshots || []).map((p) => { try { return fs.readFileSync(p).toString('base64'); } catch { return ''; } });
  check('D2b the light and dark artifacts are genuinely different images',
    bytes.length === 2 && bytes[0] && bytes[1] && bytes[0] !== bytes[1], `shots=${shotNames.join(',')}`);

  await goto('d1', base + '/clean.html');
  const vSame = await verify('d1', { themes: true, axe: false });
  check('D2c byte-identical light/dark output is REPORTED as a finding (not silent false confidence)',
    (vSame.findings || []).some((f) => f.channel === 'theme' && /identical/i.test(f.summary)),
    `findings=${(vSame.findings || []).map((f) => f.channel).join(',') || 'none'}`);

  // ===== D3 — Tailwind class-strategy dark mode ===============================
  await daemonReq(d, 'POST', '/sessions', { name: 'd3', themeClass: 'dark' });
  await goto('d3', base + '/class-theme.html');
  const vClass = await verify('d3', { themes: true, axe: false, screenshots: false });
  const repClass = readReport(vClass.artifacts?.report) || {};
  check('D3 themeClass sweeps darkMode:["class"] (no media query, no attribute — class only)',
    vClass.ok === false && (repClass.layout?.contrast || []).length === 0
    && (repClass.sweep || []).some((f) => String(f.combo).startsWith('dark') && /contrast/i.test(f.summary)),
    `baseline=${(repClass.layout?.contrast || []).length} sweep=${(repClass.sweep || []).map((f) => f.combo).join(',') || 'none'}`);

  // ===== D4 — modal backdrop is ONE info line, not N warnings =================
  await goto('d3', base + '/modal.html');
  const vModal = await verify('d3', { axe: false, screenshots: false });
  const repModal = readReport(vModal.artifacts?.report) || {};
  const modalLine = (vModal.findings || []).find((f) => /modal open/i.test(f.summary));
  check('D4 an open modal collapses its backdrop occlusions into ONE info line',
    (repModal.layout?.occlusion || []).length === 0 && !!modalLine && modalLine.severity === 'info'
    && (repModal.modal?.behind || 0) >= 6 && vModal.counts.layout === 0,
    `occlusion=${(repModal.layout?.occlusion || []).length} behind=${repModal.modal?.behind} line=${modalLine?.summary || 'none'}`);

  // ===== D5 — one warning per hidden ANCESTOR, not per descendant =============
  await goto('d3', base + '/drawer.html');
  const vDrawer = await verify('d3', { axe: false, screenshots: false });
  const repDrawer = readReport(vDrawer.artifacts?.report) || {};
  const inv = repDrawer.layout?.invisible || [];
  check('D5 a visibility:hidden ancestor is ONE grouped finding naming it (was 8)',
    inv.length === 1 && inv[0].count === 8 && /drawer/.test(inv[0].desc) && /visibility:hidden/.test(inv[0].detail),
    `invisible=${inv.length} first=${inv[0] ? inv[0].desc + ' ×' + inv[0].count : 'none'}`);

  // ===== D6 — listeners: echo the node, warn on N>1, find delegation ==========
  await goto('d3', base + '/delegate.html');
  const amb = await dbg('d3', { op: 'listeners', selector: 'button' });
  check('D6a listeners echoes WHICH element it inspected and warns that the selector matched N>1',
    amb.matchCount === 3 && amb.element?.desc === 'button#hamburger' && /matched 3 nodes/.test(amb.warning || ''),
    `matched=${amb.matchCount} el=${amb.element?.desc} warn=${(amb.warning || '').slice(0, 40)}`);
  check('D6b an empty list is NOT called dead when an ancestor holds delegated handlers',
    amb.count === 0 && (amb.delegated || []).some((g) => g.on === 'div#root' && g.types.includes('click'))
    && /no direct listeners; ancestor div#root/.test(amb.verdict || ''),
    `delegated=${(amb.delegated || []).map((g) => g.on + ':' + g.types.join('+')).join(' ') || 'none'}`);
  const direct = await dbg('d3', { op: 'listeners', selector: '#direct' });
  check('D6c a real direct listener still reports as one (and needs no ancestor walk)',
    direct.count === 1 && direct.listeners[0].type === 'click' && (direct.delegated || []).length === 0,
    `count=${direct.count} type=${direct.listeners?.[0]?.type}`);
  await goto('d3', base + '/layout.html');
  const dead = await dbg('d3', { op: 'listeners', selector: '#dead' });
  check('D6d a genuinely dead button still reads as dead (the verdict is not weakened)',
    dead.count === 0 && (dead.delegated || []).length === 0 && /dead element/.test(dead.verdict || ''),
    `verdict=${dead.verdict}`);

  // ===== D7 — leading-slash url patterns are PATHNAME patterns ================
  await goto('d3', base + '/clean.html');
  const w1 = await act('d3', 'wait', { for: { url: '/clean.html' }, timeoutMs: 1500 });
  const w2 = await act('d3', 'wait', { for: { url: '/clean' }, timeoutMs: 1200 });
  const w3 = await act('d3', 'wait', { for: { url: 'clean' }, timeoutMs: 1500 });
  check('D7a the documented `/path` form matches (SKILL.md\'s own example)', w1.matched === true, `matched=${w1.matched} in ${w1.tookMs}ms`);
  check('D7b `/clean` does NOT false-match the pathname /clean.html (segment boundary)', w2.matched === false, `matched=${w2.matched}`);
  check('D7c a bare substring still matches the full href (unchanged dialect)', w3.matched === true, `matched=${w3.matched}`);

  // ===== D9 — sweep artifacts named by the axis actually swept ================
  const vVp = await verify('d3', { viewports: true, axe: false });
  const vpNames = (vVp.artifacts?.screenshots || []).map((p) => path.basename(p));
  check('D9a a viewport sweep names its artifacts vp-*, never theme-*',
    vpNames.length === 2 && vpNames.every((n) => /-vp-(mobile|desktop)\.webp$/.test(n)) && !vpNames.some((n) => /theme/.test(n)),
    vpNames.join(','));
  const vBoth = await verify('d3', { themes: true, viewports: true, axe: false });
  const bothNames = (vBoth.artifacts?.screenshots || []).map((p) => path.basename(p));
  check('D9b a combined theme×viewport sweep produces 4 collision-free, correctly-labelled names',
    bothNames.length === 4 && new Set(bothNames).size === 4
    && bothNames.every((n) => /-(light|dark)-vp-(mobile|desktop)\.webp$/.test(n)),
    bothNames.join(','));

  // ===== D10 — a plain sleep has nothing to time out ==========================
  const slept = await act('d3', 'wait', { for: { timeout: 1200 }, timeoutMs: 400 }, 30000);
  check('D10a a sleep is never clipped by the action budget (1200ms sleep, 400ms budget)',
    slept.matched === true && slept.slept === 1200 && slept.tookMs >= 1150,
    `matched=${slept.matched} slept=${slept.slept} took=${slept.tookMs}ms`);
  const sleepCli = cli(['wait', '--sleep', '900', '--timeout', '300', '-s', 'd3'], 30000);
  check('D10b the CLI sleep exits 0 (so it can sit in an && chain)',
    sleepCli.status === 0 && /slept 900ms/.test(sleepCli.stdout), `exit=${sleepCli.status} out=${sleepCli.stdout.trim()}`);

  // ===== D11 — resize an existing session, without a 15th MCP tool ============
  const resized = cli(['session', 'resize', 'd3', '390x844']);
  const inner = await evalIn('d3', 'window.innerWidth + "x" + window.innerHeight');
  check('D11a `session resize` resizes a LIVE session (no re-open, no re-seeding)',
    resized.status === 0 && inner === '390x844', `exit=${resized.status} inner=${inner}`);
  const badVp = await post('d3', 'viewport', { width: 5, height: 5 }, 15000);
  check('D11b a nonsense viewport is a structured BAD_REQUEST, not a wedged page',
    badVp.status === HTTP_STATUS.BAD_REQUEST && badVp.body.error?.code === CODES.BAD_REQUEST,
    `status=${badVp.status} code=${badVp.body.error?.code}`);

  // The 14-tool ceiling is a hard contract: resize had to ride inside gb_session.
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm9', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const mcpRun = cli(['mcp'], 40000, { input: rpc });
  let tools = [];
  for (const line of mcpRun.stdout.trim().split('\n')) {
    try { const m = JSON.parse(line); if (m.id === 2) tools = m.result?.tools || []; } catch { /* not ours */ }
  }
  const sessionTool = tools.find((t) => t.name === 'gb_session');
  const actTool = tools.find((t) => t.name === 'gb_act');
  check('D11c the MCP surface is still exactly 14 tools, with resize folded into gb_session',
    tools.length === 14 && (sessionTool?.inputSchema?.properties?.op?.enum || []).includes('resize')
    && !!sessionTool?.inputSchema?.properties?.themeClass && !!actTool?.inputSchema?.properties?.force,
    `tools=${tools.length} ops=${(sessionTool?.inputSchema?.properties?.op?.enum || []).join('|')}`);

  // ===== observations ========================================================
  const vCli = cli(['verify', '-s', 'd3', '--no-shots', '--no-axe']);
  check('obs1 the verify summary labels the count `consoleErrors`, not the ambiguous `console`',
    vCli.status === 0 && /consoleErrors=\d+/.test(vCli.stdout) && !/ console=\d+/.test(vCli.stdout),
    vCli.stdout.split('\n')[1]?.trim());

  cli(['session', 'resize', 'd3', '1280x720']); // back to a desktop box so #free starts on screen
  await goto('d3', base + '/occlusion.html');
  const scrolled = await act('d3', 'scroll', { to: '#free' }, 30000);
  const scrolledTo = await act('d3', 'scroll', { to: 'bottom' }, 30000).then(() => act('d3', 'scroll', { to: '#free' }, 30000));
  check('obs2 `scroll --to` says whether it actually scrolled or the target was already in view',
    /already in view/.test(scrolled.note || '') && /scrolled into view/.test(scrolledTo.note || ''),
    `first=${scrolled.note} second=${scrolledTo.note}`);

  // ===== teardown ============================================================
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
