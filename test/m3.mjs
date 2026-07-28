// M3 proof: the verification engine. Cold-starts the daemon via the CLI, serves the bug-zoo
// (test/bugzoo), and drives `verify`/`read` over HTTP like m2. Asserts verify catches every
// verify-detectable seeded bug class, that the clean page yields a clean report (no false-positive
// flood), that the theme sweep catches the dark-only bug, and that a minified stack remaps to
// original.ts via the inline sourcemap. kill-all + zero-orphan check at the end. Run: `node test/m3.mjs`.
//
// Low settle/hang thresholds keep the run fast AND make the hanging-request class observable within
// a single verify (the request must outlive `GLASSBOX_HANG_MS`). Set BEFORE any daemon spawn so the
// CLI-spawned daemon inherits them.
process.env.GLASSBOX_HANG_MS = '1500';
process.env.GLASSBOX_SETTLE_CAP_MS = '2500';

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS, daemonReq } from '../src/protocol.mjs';
import { listGlassboxChromium } from '../src/daemon/prockit.mjs';
import { startBugzoo } from './bugzoo/serve.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args, timeout = 60000) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function readD() { try { return JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8')); } catch { return null; } }
function readReport(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

let zoo;
async function run() {
  zoo = await startBugzoo();
  const base = zoo.base;

  cli(['kill-all']);
  await delay(500);
  check('1 precondition clean', !fs.existsSync(PATHS.daemonFile) && listGlassboxChromium().length === 0,
    `chromium ${listGlassboxChromium().length}`);

  // 2 — cold CLI open auto-starts the daemon (inheriting our low thresholds)
  const r2 = cli(['--json', 'session', 'open', 'v']);
  const d = readD();
  check('2 cold CLI open auto-starts daemon', r2.status === 0 && !!d, `exit=${r2.status}`);
  if (!d) return;
  const call = async (verb, body, ms) => (await daemonReq(d, 'POST', `/sessions/v/${verb}`, body || {}, ms)).body;
  const goto = (url) => call('goto', { url }, 30000);
  const verify = (body) => call('verify', body || {}, 90000);
  const read = (body) => call('read', body || {}, 30000);

  // 3 — errors.html: console error, unhandled rejection, 404 asset, 500 fetch, hanging request
  await goto(base + '/errors.html');
  const ve = await verify({ screenshots: false });
  const c = ve.counts || {};
  check('3a errors: console.error caught', c.consoleErrors >= 1, `consoleErrors=${c.consoleErrors}`);
  check('3b errors: unhandled rejection (pageerror) caught', c.pageErrors >= 1, `pageErrors=${c.pageErrors}`);
  check('3c errors: 404 asset + 500 fetch → httpError', c.netHttpError >= 2, `netHttpError=${c.netHttpError}`);
  check('3d errors: hanging request caught', c.netHanging >= 1, `netHanging=${c.netHanging}`);
  check('3e errors: report is ok:false', ve.ok === false, `ok=${ve.ok}`);

  // 3f — read(network) taxonomy independently reflects the same classes
  const rn = await read({ channel: 'network' });
  check('3f read(network) taxonomy', rn.counts?.httpError >= 2 && rn.counts?.hanging >= 1,
    `http=${rn.counts?.httpError} hang=${rn.counts?.hanging}`);

  // 4 — layout.html: overflow, occlusion, zero-size, contrast, broken image, CLS, aria-less button
  await goto(base + '/layout.html');
  const vl = await verify({});
  const rep = readReport(vl.artifacts?.report) || {};
  const L = rep.layout || {};
  check('4a layout: horizontal overflow', (L.overflow || []).length >= 1, `overflow=${(L.overflow || []).length}`);
  check('4b layout: occluded interactive element', (L.occlusion || []).length >= 1, `occlusion=${(L.occlusion || []).length}`);
  check('4c layout: zero-size target', (L.zeroSize || []).length >= 1, `zeroSize=${(L.zeroSize || []).length}`);
  check('4d layout: white-on-white contrast', (L.contrast || []).length >= 1, `contrast=${(L.contrast || []).length}`);
  check('4e layout: broken image', (L.brokenImages || []).length >= 1, `brokenImages=${(L.brokenImages || []).length}`);
  check('4f layout: CLS shifter', (L.cls || []).length >= 1, `cls=${(L.cls || []).length}`);
  check('4g a11y: icon button has no accessible name', (rep.a11y || []).some((g) => g.ruleId === 'button-name'),
    `rules=${(rep.a11y || []).map((g) => g.ruleId).join(',')}`);
  check('4h layout report is ok:false + screenshot written', vl.ok === false && (vl.artifacts?.screenshots || []).length >= 1,
    `ok=${vl.ok} shots=${(vl.artifacts?.screenshots || []).length}`);

  // 4i — the scrollbar-gutter overflow case, which 4a does NOT cover. layout.html's `#wide` is
  // 3000px and overflows by ~2200px, so it is caught even by a browser that reports no scrollbar.
  // overflow-vw.html overflows by exactly the gutter width, so it is caught ONLY if the launcher
  // let the scrollbar exist. This check fails against every commit before the
  // `ignoreDefaultArgs: ['--hide-scrollbars']` fix in platform.mjs, and it is the regression that
  // pins it. Setting GLASSBOX_HIDE_SCROLLBARS=1 reproduces the old blindness on demand.
  await goto(base + '/overflow-vw.html');
  const vv = await verify({ screenshots: false });
  const OV = (readReport(vv.artifacts?.report) || {}).layout?.overflow || [];
  check('4i layout: 100vw overflows by exactly the scrollbar gutter (the case --hide-scrollbars erases)',
    OV.some((f) => /vw/.test(JSON.stringify(f))),
    `overflow=${OV.length} ${OV.map((f) => f.desc || '').join(',') || 'none'}`);

  // 5 — sourcemap.html: minified throw remaps to original.ts:4 via the inline source map
  await goto(base + '/sourcemap.html');
  const rs = await read({ channel: 'errors' });
  const smErr = (rs.entries || []).find((e) => /SEED sourcemap boom/.test(e.text));
  check('5 sourcemap: stack remaps to original.ts:4',
    !!smErr && smErr.orig?.file === 'original.ts' && smErr.orig?.line === 4,
    `orig=${JSON.stringify(smErr?.orig)}`);

  // 6 — dark.html: theme sweep catches a white-on-white bug present only in dark mode
  await goto(base + '/dark.html');
  const vd = await verify({ themes: true });
  const drep = readReport(vd.artifacts?.report) || {};
  const baselineClean = (drep.layout?.contrast || []).length === 0;
  const darkCatch = (drep.sweep || []).some((f) => f.combo && f.combo.startsWith('dark') && /contrast/i.test(f.summary));
  check('6a dark: baseline (light) is contrast-clean', baselineClean, `baselineContrast=${(drep.layout?.contrast || []).length}`);
  check('6b dark: theme sweep catches the dark-only contrast bug', darkCatch && vd.ok === false,
    `ok=${vd.ok} sweep=${JSON.stringify((drep.sweep || []).map((f) => f.combo))}`);
  check('6c dark: sweep produced light+dark screenshots', (vd.artifacts?.screenshots || []).length >= 2,
    `shots=${(vd.artifacts?.screenshots || []).length}`);

  // 7 — clean.html: no false-positive flood
  await goto(base + '/clean.html');
  const vc = await verify({ screenshots: false });
  check('7 clean page → ok:true with < 2 findings', vc.ok === true && (vc.findings || []).length < 2,
    `ok=${vc.ok} findings=${(vc.findings || []).length} counts=${JSON.stringify(vc.counts)}`);

  // 8 — CLI verbs: `verify` prints a human summary; `read` works over the bin
  const cliV = cli(['verify', '-s', 'v', '--no-shots']);
  check('8a CLI verify verb', cliV.status === 0 && /verify (OK|ISSUES)/.test(cliV.stdout), `exit=${cliV.status}`);
  const cliR = cli(['read', 'errors', '-s', 'v']);
  check('8b CLI read verb', cliR.status === 0, `exit=${cliR.status}`);

  // 9 — read(overlay) returns cleanly (no build overlay on a plain page)
  const ov = await read({ channel: 'overlay' });
  check('9 read(overlay) no-overlay is graceful', ov.ok === true && ov.overlay === null, `overlay=${JSON.stringify(ov.overlay)}`);

  // 10 — teardown: kill-all removes discovery file and leaves zero chromium strays
  const before = listGlassboxChromium().length;
  cli(['--json', 'kill-all']);
  await delay(700);
  const after = listGlassboxChromium().length;
  check('10a kill-all removes daemon.json', !fs.existsSync(PATHS.daemonFile));
  check('10b kill-all leaves zero chromium strays', after === 0, `chromium ${before} -> ${after}`);
}

function finish() {
  try { zoo?.close(); } catch { /* already closed */ }
  cli(['kill-all']);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.log('FAIL  harness threw —', e?.stack || e);
  results.push({ name: 'harness', pass: false });
}).finally(finish);
