// M8 proof: end-to-end system validation — the whole box under load, the consolidated seed table,
// the artifact contract, and the hardening invariants. Five parts:
//   (a) PARALLEL STRESS — 4 sessions created concurrently, each on a different bug-zoo page, all 4
//       running `verify` CONCURRENTLY (async daemonReq, never spawnSync): one wall-clock budget,
//       independent + correct results (the broken pages report their own seeds and only their own;
//       the clean page reports ok:true). Then the headline guarantee end to end: one session pauses
//       at a breakpoint while the other three re-verify concurrently and finish.
//   (b) FULL SEED SWEEP — one table-driven pass asserting every seeded bug class from the M8 list
//       (build-plan §M8) is caught by its designated channel, including the two that verify alone
//       cannot see: the dead (no-handler) button via debug listeners, and the native dialog via the
//       act→dialog flow. Plus the simulated Astro island: settle waits for `astro-island[ssr]` to
//       clear, and reports why:['astro'] (never hangs) when it never does.
//   (c) ARTIFACT CONTRACT — every stressed session lists journal + ≥1 report; journal.jsonl parses
//       as JSONL and carries create → goto → verify in order.
//   (d) HARDENING INVARIANTS — CODES/HTTP_STATUS parity; protocol purity of the shim's import graph
//       (no stdout writer reachable but the JSON-RPC framer); one version across package.json,
//       daemon.json and MCP serverInfo; `--help` renders and every verb it documents dispatches.
//   (e) zero-orphan + daemon.json cleanup.
// Run: `node test/m8.mjs`.
//
// The bug zoo runs as a CHILD PROCESS here, not in-process: this proof mixes spawnSync CLI calls
// with live page traffic, and a spawnSync blocks the event loop an in-process server would need to
// answer (the M7 deadlock lesson). Low hang/settle thresholds are set before any daemon spawn so
// the CLI-spawned daemon inherits them (as in m3).
process.env.GLASSBOX_HANG_MS = '1500';
process.env.GLASSBOX_SETTLE_CAP_MS = '2500';

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS, VERSION, CODES, HTTP_STATUS, daemonReq } from '../src/protocol.mjs';
import { listGlassboxChromium } from '../src/daemon/prockit.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVE = fileURLToPath(new URL('./bugzoo/serve.mjs', import.meta.url));
const SHIM = fileURLToPath(new URL('../src/mcp-shim.mjs', import.meta.url));
const PKG = fileURLToPath(new URL('../package.json', import.meta.url));
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

/** Start the bug zoo in its own process and read its base URL off stdout. */
async function startZooProcess() {
  const child = spawn(process.execPath, [SERVE], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => { /* the zoo is quiet; keep the pipe drained */ });
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

  const r0 = cli(['--json', 'daemon', 'start']);
  const d = readD();
  check('0b cold CLI start brings the daemon up', r0.status === 0 && !!d, `exit=${r0.status} pid=${d?.pid}`);
  if (!d) return;

  const post = (s, verb, body, ms) => daemonReq(d, 'POST', `/sessions/${s}/${verb}`, body || {}, ms);
  const act = async (s, verb, body, ms) => (await post(s, verb, body, ms)).body;
  const goto = (s, url) => act(s, 'goto', { url }, 60000);
  const verify = (s, body) => act(s, 'verify', body || {}, 120000);
  const dbg = (s, body, ms = 60000) => act(s, 'debug', body, ms);
  const evalIn = async (s, expression) => (await act(s, 'eval', { expression }, 30000)).value;

  // ===== (a) parallel stress =================================================
  // Four sessions, four different pages, one browser. Broken pages must report THEIR OWN seeds and
  // nothing from a sibling (cross-talk in the context-scoped buffers would show up right here).
  const PAR = [
    { name: 'par-errors', page: '/errors.html' },
    { name: 'par-layout', page: '/layout.html' },
    { name: 'par-debug', page: '/debug.html' },
    { name: 'par-clean', page: '/clean.html' },
  ];
  const created = await Promise.all(PAR.map((p) => daemonReq(d, 'POST', '/sessions', { name: p.name }, 90000)));
  check('a1 4 sessions created concurrently', created.every((r) => r.status === 200),
    `status=${created.map((r) => r.status).join(',')}`);

  const gotos = await Promise.all(PAR.map((p) => goto(p.name, base + p.page)));
  check('a2 all 4 navigated concurrently to their own page', gotos.every((g) => g.ok === true),
    `urls=${gotos.map((g) => (g.url || '').split('/').pop()).join(',')}`);

  const tPar = Date.now();
  const vs = await Promise.all(PAR.map((p) => verify(p.name, {})));
  const parMs = Date.now() - tPar;
  const V = Object.fromEntries(PAR.map((p, i) => [p.name, vs[i]]));
  check('a3 4 concurrent verifies all completed inside one 60s budget', vs.every((v) => v && v.counts) && parMs < 60000,
    `${parMs}ms  ok=${vs.map((v) => v?.ok).join(',')}`);

  const ce = V['par-errors'].counts || {};
  check('a4 the errors session reports ITS seeds (console + pageerror + http + hanging)',
    V['par-errors'].ok === false && ce.consoleErrors >= 1 && ce.pageErrors >= 1 && ce.netHttpError >= 2 && ce.netHanging >= 1,
    `counts=${JSON.stringify(ce)}`);

  // The layout page has ONE console error of its own (Chrome logs the broken image's 404), so the
  // cross-talk test is by content, not by count: none of the errors page's seeds may appear here.
  const cl = V['par-layout'].counts || {};
  const clText = (V['par-layout'].findings || []).map((f) => f.summary).join(' | ');
  check('a5 the layout session reports layout pathology and NONE of the errors page seeds',
    V['par-layout'].ok === false && cl.layout >= 4 && cl.pageErrors === 0 && cl.netHanging === 0
    && !/SEED (console-error|unhandled-rejection)/.test(clText) && !/api\/(500|hang)/.test(clText),
    `layout=${cl.layout} console=${cl.consoleErrors} pageerr=${cl.pageErrors} hang=${cl.netHanging}`);

  const cd = V['par-debug'].counts || {};
  check('a6 the debug session reports its white-on-white seed only',
    V['par-debug'].ok === false && cd.layout >= 1 && cd.consoleErrors === 0 && cd.netHttpError === 0,
    `layout=${cd.layout} console=${cd.consoleErrors} http=${cd.netHttpError}`);

  check('a7 the CLEAN session in the same browser is ok:true with < 2 findings',
    V['par-clean'].ok === true && (V['par-clean'].findings || []).length < 2,
    `ok=${V['par-clean'].ok} findings=${(V['par-clean'].findings || []).length} counts=${JSON.stringify(V['par-clean'].counts)}`);

  check('a8 each report is bound to its own session URL (no result mixing)',
    PAR.every((p) => (V[p.name].url || '').endsWith(p.page)),
    PAR.map((p) => `${p.name}→${(V[p.name].url || '').split('/').pop()}`).join(' '));

  // --- the headline guarantee: one session paused, three still working --------
  const br = await dbg('par-debug', { op: 'break', file: 'debug.js', line: 5 });
  check('a9 breakpoint set on the debug session', br.ok === true && br.line >= 5, `${br.file}:${br.line}`);

  const parkedClick = post('par-debug', 'click', { selector: '#primary' }, 60000).catch(() => {}); // fire-and-forget
  let st = { paused: false };
  for (let i = 0; i < 100 && !st.paused; i++) { st = await dbg('par-debug', { op: 'state' }); if (!st.paused) await delay(100); }
  check('a10 the debug session is paused at the breakpoint', st.paused === true && st.frames?.[0]?.functionName === 'onPrimary',
    `paused=${st.paused} fn=${st.frames?.[0]?.functionName}`);

  const others = PAR.filter((p) => p.name !== 'par-debug');
  const tPaused = Date.now();
  const reVerify = await Promise.all(others.map((p) => post(p.name, 'verify', { screenshots: false }, 120000)));
  const pausedMs = Date.now() - tPaused;
  const stillPaused = await dbg('par-debug', { op: 'state' });
  check('a11 the other 3 sessions re-verify CONCURRENTLY while one is paused',
    reVerify.every((r) => r.status === 200 && r.body?.counts) && pausedMs < 60000 && stillPaused.paused === true,
    `${pausedMs}ms status=${reVerify.map((r) => r.status).join(',')} stillPaused=${stillPaused.paused}`);
  check('a12 those results are still correct (clean stays clean, broken stays broken)',
    reVerify[0].body.ok === false && reVerify[1].body.ok === false && reVerify[2].body.ok === true,
    others.map((p, i) => `${p.name}:${reVerify[i].body.ok}`).join(' '));

  const t0 = Date.now();
  const pausedTry = await post('par-debug', 'click', { selector: '#dead' }, 15000);
  check('a13 a normal action on the PAUSED session fails fast with a structured PAUSED error',
    pausedTry.status === HTTP_STATUS.PAUSED && pausedTry.body.error?.code === CODES.PAUSED && Date.now() - t0 < 5000,
    `status=${pausedTry.status} code=${pausedTry.body.error?.code} ms=${Date.now() - t0}`);

  const resumed = await dbg('par-debug', { op: 'resume' });
  await Promise.race([parkedClick, delay(8000)]);
  await dbg('par-debug', { op: 'remove', all: true });
  check('a14 resume releases the session (parked click completes)',
    resumed.resumed === true && /primary-done-42/.test(String(await evalIn('par-debug', 'document.body.innerText'))),
    `resumed=${resumed.resumed}`);

  // ===== (c) artifact contract (on the sessions the stress just exercised) ====
  for (const p of PAR) {
    const arts = (await daemonReq(d, 'GET', `/sessions/${p.name}/artifacts`)).body || {};
    const kinds = arts.artifacts || {};
    const hasJournal = (kinds.journal || []).some((f) => f.rel === 'journal.jsonl' && f.bytes > 0);
    const reports = (kinds.reports || []).filter((f) => /verify-\d+\.json$/.test(f.rel));
    check(`c1 artifacts[${p.name}] lists the journal + ≥1 verify report`,
      hasJournal && reports.length >= 1,
      `journal=${hasJournal} reports=${reports.length} shots=${(kinds.shots || []).length}`);
  }

  const jpath = path.join(PATHS.sessions, 'par-clean', 'journal.jsonl');
  const rawLines = fs.readFileSync(jpath, 'utf8').trim().split('\n').filter(Boolean);
  let parsed = [];
  let badLine = null;
  for (const l of rawLines) { try { parsed.push(JSON.parse(l)); } catch { badLine = l.slice(0, 60); break; } }
  check('c2 journal.jsonl is valid JSONL (every line an object with ts + event)',
    !badLine && parsed.length === rawLines.length && parsed.every((e) => e && typeof e.ts === 'number' && typeof e.event === 'string'),
    `lines=${rawLines.length}${badLine ? ` bad=${badLine}` : ''}`);
  const iCreate = parsed.findIndex((e) => e.event === 'create');
  const iGoto = parsed.findIndex((e) => e.event === 'command' && e.op === 'goto');
  const iVerify = parsed.findIndex((e) => e.event === 'command' && e.op === 'verify');
  check('c3 journal carries create → goto → verify IN ORDER',
    iCreate === 0 && iGoto > iCreate && iVerify > iGoto,
    `create=${iCreate} goto=${iGoto} verify=${iVerify} events=${parsed.map((e) => e.event + (e.op ? ':' + e.op : '')).join(',')}`);

  // ===== (b) the consolidated seed table =====================================
  // One session walks the zoo; each page is prepared ONCE into a context, then every seeded class
  // from the build-plan M8 list is asserted against the channel that is supposed to catch it.
  await daemonReq(d, 'POST', '/sessions', { name: 'sweep' });

  const CTX = {
    '/errors.html': async (s) => {
      await goto(s, base + '/errors.html');
      const v = await verify(s, { screenshots: false });
      return { v, rep: readReport(v.artifacts?.report) || {} };
    },
    '/layout.html': async (s) => {
      await goto(s, base + '/layout.html');
      const v = await verify(s, {});
      return {
        v, rep: readReport(v.artifacts?.report) || {},
        dead: await dbg(s, { op: 'listeners', selector: '#dead' }),
        live: await dbg(s, { op: 'listeners', selector: '#live' }),
      };
    },
    '/dark.html': async (s) => {
      await goto(s, base + '/dark.html');
      const v = await verify(s, { themes: true });
      return { v, rep: readReport(v.artifacts?.report) || {} };
    },
    '/dialog.html': async (s) => {
      await goto(s, base + '/dialog.html');
      const click = await act(s, 'click', { selector: '#ask' }, 30000);
      const answer = await act(s, 'dialog', { action: 'accept' }, 30000);
      return { click, answer, title: await evalIn(s, 'document.title') };
    },
    '/hydrate.html': async (s) => {
      const slow = await goto(s, base + '/hydrate.html');
      const hydrated = await evalIn(s, '!document.querySelector("astro-island[ssr]") && !!window.__gbxHydratedAt');
      const stuck = await goto(s, base + '/hydrate.html?stuck=1');
      const stuckIsland = await evalIn(s, '!!document.querySelector("astro-island[ssr]")');
      return { slow, hydrated, stuck, stuckIsland };
    },
  };

  const SEEDS = [
    { cls: 'console error', page: '/errors.html', via: 'verify/console',
      probe: (c) => c.v.counts.consoleErrors >= 1, detail: (c) => `consoleErrors=${c.v.counts.consoleErrors}` },
    { cls: 'unhandled rejection', page: '/errors.html', via: 'verify/pageerror',
      probe: (c) => c.v.counts.pageErrors >= 1, detail: (c) => `pageErrors=${c.v.counts.pageErrors}` },
    { cls: '404 asset', page: '/errors.html', via: 'verify/network httpError',
      probe: (c) => (c.rep.network?.httpError || []).some((r) => /nope-404\.js/.test(r.url) && r.status === 404),
      detail: (c) => (c.rep.network?.httpError || []).map((r) => `${r.status} ${new URL(r.url).pathname}`).join(' ') },
    { cls: '4xx/5xx fetch', page: '/errors.html', via: 'verify/network httpError',
      probe: (c) => (c.rep.network?.httpError || []).some((r) => /\/api\/500/.test(r.url) && r.status === 500),
      detail: (c) => `httpError=${(c.rep.network?.httpError || []).length}` },
    { cls: 'hanging request', page: '/errors.html', via: 'verify/network hanging',
      probe: (c) => (c.rep.network?.hanging || []).some((r) => /\/api\/hang/.test(r.url)),
      detail: (c) => `hanging=${(c.rep.network?.hanging || []).length}` },

    { cls: 'horizontal overflow', page: '/layout.html', via: 'verify/layout',
      probe: (c) => (c.rep.layout?.overflow || []).length >= 1, detail: (c) => `overflow=${(c.rep.layout?.overflow || []).length}` },
    { cls: 'white-on-white text', page: '/layout.html', via: 'verify/layout contrast',
      probe: (c) => (c.rep.layout?.contrast || []).length >= 1, detail: (c) => `contrast=${(c.rep.layout?.contrast || []).length}` },
    { cls: 'zero-size button', page: '/layout.html', via: 'verify/layout',
      probe: (c) => (c.rep.layout?.zeroSize || []).length >= 1, detail: (c) => `zeroSize=${(c.rep.layout?.zeroSize || []).length}` },
    { cls: 'occluded button', page: '/layout.html', via: 'verify/layout',
      probe: (c) => (c.rep.layout?.occlusion || []).length >= 1, detail: (c) => `occlusion=${(c.rep.layout?.occlusion || []).length}` },
    { cls: 'broken image', page: '/layout.html', via: 'verify/layout',
      probe: (c) => (c.rep.layout?.brokenImages || []).length >= 1, detail: (c) => `broken=${(c.rep.layout?.brokenImages || []).length}` },
    { cls: 'invisible-but-laid-out button', page: '/layout.html', via: 'verify/layout invisible',
      probe: (c) => (c.rep.layout?.invisible || []).some((f) => /ghost/.test(f.desc) && /opacity:0/.test(f.detail)),
      detail: (c) => `invisible=${(c.rep.layout?.invisible || []).map((f) => f.desc).join(',') || 'none'}` },
    { cls: 'display:none is NOT a finding (responsive false-positive guard)', page: '/layout.html', via: 'verify/layout',
      probe: (c) => !/offmenu|offlink|offbtn/.test(JSON.stringify(c.rep.layout || {})),
      detail: (c) => `layout mentions of the hidden nav: ${(JSON.stringify(c.rep.layout || {}).match(/off(menu|link|btn)/g) || []).join(',') || 'none'}` },
    { cls: 'CLS shifter', page: '/layout.html', via: 'verify/layout cls',
      probe: (c) => (c.rep.layout?.cls || []).length >= 1, detail: (c) => `cls=${(c.rep.layout?.cls || []).length}` },
    { cls: 'aria-less icon button', page: '/layout.html', via: 'verify/a11y (axe button-name)',
      probe: (c) => (c.rep.a11y || []).some((g) => g.ruleId === 'button-name'),
      detail: (c) => `rules=${(c.rep.a11y || []).map((g) => g.ruleId).join(',') || 'none'}` },
    { cls: 'dead (no-handler) button', page: '/layout.html', via: 'debug listeners',
      probe: (c) => c.dead.ok === true && c.dead.count === 0 && c.live.count >= 1,
      detail: (c) => `#dead=${c.dead.count} #live=${c.live.count}` },

    { cls: 'dark-theme-only regression', page: '/dark.html', via: 'verify theme sweep',
      probe: (c) => c.v.ok === false && (c.rep.layout?.contrast || []).length === 0
        && (c.rep.sweep || []).some((f) => String(f.combo).startsWith('dark') && /contrast/i.test(f.summary)),
      detail: (c) => `baseline=${(c.rep.layout?.contrast || []).length} sweep=${(c.rep.sweep || []).map((f) => f.combo).join(',')}` },

    { cls: 'native dialog', page: '/dialog.html', via: 'act → dialog flow',
      probe: (c) => c.click.dialog?.type === 'confirm' && c.answer.action === 'accept' && c.title === 'confirmed',
      detail: (c) => `surfaced=${c.click.dialog?.type} msg=${JSON.stringify(c.click.dialog?.message)} title=${c.title}` },

    { cls: 'Astro-island hydration delay', page: '/hydrate.html', via: 'settle astro signal',
      probe: (c) => c.slow.settled === true && c.slow.tookMs >= 800 && c.hydrated === true,
      detail: (c) => `settled=${c.slow.settled} tookMs=${c.slow.tookMs} hydrated=${c.hydrated}` },
    { cls: 'island that never hydrates', page: '/hydrate.html', via: 'settle why:[astro] (no hang)',
      probe: (c) => c.stuck.settled === false && (c.stuck.settleWhy || []).includes('astro') && c.stuckIsland === true,
      detail: (c) => `settled=${c.stuck.settled} why=${(c.stuck.settleWhy || []).join(',')}` },
  ];

  const pages = [...new Set(SEEDS.map((s) => s.page))];
  for (const page of pages) {
    let ctx = null;
    let err = '';
    try { ctx = await CTX[page]('sweep'); } catch (e) { err = e?.message || String(e); }
    for (const seed of SEEDS.filter((s) => s.page === page)) {
      let ok = false;
      let det = err ? `page setup threw: ${err}` : '';
      if (ctx) { try { ok = !!seed.probe(ctx); det = seed.detail(ctx); } catch (e) { det = `probe threw: ${e?.message || e}`; } }
      check(`b seed [${seed.cls}] caught by ${seed.via}`, ok, det);
    }
  }

  // ===== (d) hardening invariants ============================================
  const codeNames = Object.keys(CODES);
  const missingStatus = codeNames.filter((c) => !HTTP_STATUS[c]);
  const orphanStatus = Object.keys(HTTP_STATUS).filter((c) => !CODES[c]);
  check('d1 every error CODE has an HTTP_STATUS (and no orphan statuses)',
    missingStatus.length === 0 && orphanStatus.length === 0,
    `codes=${codeNames.length} missing=${missingStatus.join(',') || 'none'} orphans=${orphanStatus.join(',') || 'none'}`);

  // Protocol purity, statically: nothing reachable from the MCP shim may write to stdout except the
  // shim's own JSON-RPC framer. A stray console.log in a shared module corrupts the protocol stream.
  const graph = importGraph(SHIM);
  const noisy = [];
  for (const f of graph) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;
      if (/console\.(log|info|warn|debug)\s*\(/.test(t)) noisy.push(`${path.basename(f)}:${i + 1} console`);
      if (/process\.stdout\.write\s*\(/.test(t) && f !== SHIM) noisy.push(`${path.basename(f)}:${i + 1} stdout`);
    });
  }
  check('d2 protocol purity: no stdout writer in the shim import graph but the JSON-RPC framer',
    noisy.length === 0, `graph=${graph.map((f) => path.basename(f)).join(',')} noisy=${noisy.join(' ') || 'none'}`);

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const initLine = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm8', version: '0' } } }) + '\n';
  const mcpRun = cli(['mcp'], 40000, { input: initLine });
  let serverInfo = null;
  try { serverInfo = JSON.parse((mcpRun.stdout.trim().split('\n')[0] || '{}')).result?.serverInfo || null; } catch { /* left null */ }
  check('d3 one version everywhere (package.json = protocol = daemon.json = MCP serverInfo)',
    pkg.version === VERSION && readD()?.version === VERSION && serverInfo?.version === VERSION,
    `pkg=${pkg.version} protocol=${VERSION} daemon=${readD()?.version} mcp=${serverInfo?.version}`);

  const help = cli(['--help'], 20000);
  const banner = /^glassbox <command>/m;
  const sections = ['SESSIONS', 'NAVIGATE \\+ ACT', 'OBSERVE \\+ VERIFY', 'DEBUG', 'WATCH', 'DEV LOOP'];
  check('d4 `--help` renders the full command reference and exits 0',
    help.status === 0 && banner.test(help.stdout) && sections.every((s) => new RegExp(s).test(help.stdout)),
    `exit=${help.status} lines=${help.stdout.split('\n').length}`);

  const documented = helpVerbs(help.stdout);
  check('d5 the help text documents the whole verb surface (≥ 25 verbs parsed)', documented.length >= 25,
    `verbs=${documented.join(' ')}`);

  // Every documented verb must actually dispatch: an unknown verb falls through to the help dump,
  // a real one either works or fails with a structured error. `kill-all` is destructive (it is
  // proven by every proof's teardown) so it is checked against the dispatch table in source.
  const source = fs.readFileSync(CLI, 'utf8');
  const PROBE = {
    // `dev` is pinned to the repo root on purpose: no `dev`/`start` script there, so it fails with a
    // structured BAD_REQUEST instead of spawning whatever dev server the caller's cwd happens to hold.
    daemon: ['daemon', 'status'], session: ['session', 'ls'], mcp: ['mcp'], dev: ['dev', '--cwd', ROOT], watch: ['watch'],
    goto: ['goto', 'http://127.0.0.1:9/'], click: ['click', '#x'], dblclick: ['dblclick', '#x'], hover: ['hover', '#x'],
    type: ['type', 'x'], press: ['press', 'Enter'], read: ['read', 'errors'], dialog: ['dialog', 'dismiss'],
    eval: ['eval', '1+1'], style: ['style', '#x'], debug: ['debug', 'state'],
  };
  const undispatched = [];
  for (const verb of documented) {
    if (verb === 'kill-all') {
      if (!source.includes("verb === 'kill-all'")) undispatched.push(verb);
      continue;
    }
    const args = (PROBE[verb] || [verb]).concat(['-s', '__gbx_no_such_session__']);
    const r = cli(args, 40000, verb === 'mcp' ? { input: '' } : {});
    if (banner.test(r.stdout)) undispatched.push(verb);
  }
  check('d6 every documented verb dispatches (none falls through to the help dump)',
    undispatched.length === 0, `checked=${documented.length} undispatched=${undispatched.join(',') || 'none'}`);

  // ===== (e) teardown ========================================================
  const before = listGlassboxChromium().length;
  const ka = cli(['--json', 'kill-all']);
  await delay(800);
  const after = listGlassboxChromium().length;
  check('e1 kill-all removes daemon.json', !fs.existsSync(PATHS.daemonFile), ka.stdout.trim().slice(0, 90));
  check('e2 kill-all leaves zero chromium orphans', after === 0, `chromium ${before} -> ${after}`);
}

/** Resolve the transitive relative-import graph of an ESM entry file (absolute paths). */
function importGraph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      stack.push(path.resolve(path.dirname(f), m[1]));
    }
  }
  return [...seen];
}

/**
 * Pull the documented verbs out of the CLI help: command lines are indented exactly two spaces,
 * a line can hold two commands separated by a run of ≥4 spaces, and a leading `a|b|c` is an
 * alternation of verbs (click|dblclick|hover). Prose/continuation lines are indented deeper.
 */
function helpVerbs(text) {
  const verbs = new Set();
  for (const line of text.split('\n')) {
    if (!/^ {2}[a-z]/.test(line)) continue;
    for (const seg of line.trim().split(/ {4,}/)) {
      const first = seg.trim().split(/\s+/)[0] || '';
      if (!/^[a-z][a-z-]*(\|[a-z][a-z-]*)*$/.test(first)) continue;
      for (const v of first.split('|')) verbs.add(v);
    }
  }
  return [...verbs];
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
