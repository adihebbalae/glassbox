// M13 — the sandbox backend. Proves the four platform members (launcher / network policy /
// human channel / lifecycle) behave, and that the finding engine says what it measured under.
//
// Runs on BOTH platforms on purpose. Nothing here is skipped for being on Windows; the checks that
// depend on a jailed network detect that condition and assert the OTHER side of the branch instead
// of quietly passing. A test that goes green because it could not look is the exact failure this
// milestone exists to remove — see the prockit note below.
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PATHS } from '../src/protocol.mjs';
import { KIND, stateRoot, chromiumPath, findChromium } from '../src/platform.mjs';
import { classifyEgress, splitEgress } from '../src/daemon/egress.mjs';
import { fontState, blockedFontEvidence } from '../src/daemon/stubs.mjs';
import { buildReportHtml } from '../src/report-html.mjs';
import { listGlassboxChromium } from '../src/daemon/prockit.mjs';


const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const SERVE = fileURLToPath(new URL('./bugzoo/serve.mjs', import.meta.url));
const THIRD_PARTY = fileURLToPath(new URL('./fixtures/third-party.mjs', import.meta.url));

/**
 * Both fixture servers run as CHILD PROCESSES, never in-process.
 *
 * This is not a style preference. `gb()` drives the CLI with spawnSync, which blocks this process's
 * event loop for the whole call — so an http server living in this process cannot answer a single
 * request while the browser is being driven. The first version of this test did exactly that and
 * produced a beautifully plausible lie: the HAR came back with two entries, the page reported "api
 * dead", and every assertion pointed at the HAR bridge instead of at the harness.
 */
function startServer(entry, args = [], env = {}) {
  const child = spawn(process.execPath, [entry, ...args], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env } });
  const base = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${path.basename(entry)} printed no URL in 10s`)), 10000);
    child.stdout.on('data', (b) => { const m = /(http:\/\/\S+)/.exec(String(b)); if (m) { clearTimeout(t); res(m[1]); } });
  });
  return { child, base, kill: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};
const gb = (args, timeout = 120000) => {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { encoding: 'utf8', timeout });
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { return { _raw: r.stdout, _err: r.stderr, _status: r.status }; }
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ─── 1. Platform seam: pure-function proofs, no browser needed ────────────────────────────
  check('1a state root is absolute', path.isAbsolute(stateRoot()), stateRoot());
  // The old fallback chain ended in '.', so on a box with no LOCALAPPDATA the root was RELATIVE and
  // the CLI, a daemon spawned with another cwd, and this test could each compute a different one.
  check('1b state root never relative to cwd', !stateRoot().startsWith('.'), stateRoot());
  check('1c platform kind is known', ['win32', 'sandbox', 'posix'].includes(KIND), KIND);
  if (KIND !== 'win32') {
    const c = findChromium();
    check('1d chromium resolved by PATH, not by playwright revision', !!c.path, `${c.path || '(none)'} via ${c.why}`);
  } else {
    check('1d chromium via playwright channel on win32', chromiumPath().path === null, 'channel:chromium');
  }

  // ─── 2. Egress classifier: the fifth bucket, as a pure function ───────────────────────────
  const ctx = { policy: 'jailed', origins: ['http://127.0.0.1:5173'] };
  check('2a loopback failure is ALWAYS the app',
    classifyEgress({ url: 'http://localhost:5173/api/cart', failed: true, errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }, ctx) === 'app',
    'a broken local API can never be excused as "the sandbox did it"');
  check('2b own-origin failure is the app',
    classifyEgress({ url: 'http://127.0.0.1:5173/x.js', failed: true, errorText: 'net::ERR_CONNECTION_REFUSED' }, ctx) === 'app');
  check('2c external proxy refusal is the sandbox',
    classifyEgress({ url: 'https://fonts.googleapis.com/css2', failed: true, errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }, ctx) === 'sandbox');
  check('2d external 500 is still the app',
    classifyEgress({ url: 'https://api.stripe.com/v1/x', status: 500 }, ctx) === 'app',
    'a reachable API returning 500 is a real defect, not an environment artifact');
  check('2e open policy demotes nothing',
    classifyEgress({ url: 'https://fonts.googleapis.com/css2', failed: true, errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }, { policy: 'open', origins: [] }) === 'app');
  const split = splitEgress(
    { failed: [{ url: 'https://cdn.jsdelivr.net/a.js', errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }, { url: 'http://localhost:3000/x', errorText: 'net::ERR_CONNECTION_REFUSED' }], httpError: [] },
    { policy: 'jailed', origins: ['http://localhost:3000'] });
  check('2f split moves only the jail casualties',
    split.sandboxBlocked.length === 1 && split.net.failed.length === 1,
    `blocked=${split.sandboxBlocked.length} kept=${split.net.failed.length}`);

  // ─── 3. Font state is asserted on EVIDENCE, never on being in a container ──────────────────
  check('3a jailed + no font evidence => local-only, not a false warning',
    fontState({ jailed: true, stubs: null, evidence: 0 }) === 'local-only',
    'a page that ships no web fonts loses nothing to a jailed network');
  check('3b jailed + evidence => substituted', fontState({ jailed: true, stubs: null, evidence: 2 }) === 'substituted');
  check('3c HAR with fonts wins', fontState({ jailed: true, stubs: { fonts: 3 }, evidence: 9 }) === 'har-replayed');
  check('3d blocked stylesheet counts as font evidence',
    blockedFontEvidence([{ url: 'https://fonts.googleapis.com/css2?family=Inter', type: 'Stylesheet' }]) === 1,
    'a blocked Google Fonts CSS means the @font-face rules never existed, so no font request is even attempted');

  // ─── 4. Live: record a HAR, kill the origin, prove replay restores fidelity ────────────────
  gb(['kill-all', '--force']);
  await delay(500);

  const tp = startServer(THIRD_PARTY);
  const tpBase = await tp.base;
  const zoo = startServer(SERVE, [], { GLASSBOX_TP_BASE: tpBase });
  const base = await zoo.base;
  const har = path.join(os.tmpdir(), `gb-m13-${process.pid}.har`);

  try {
    const openRec = gb(['session', 'open', 'm13rec', '--record-har', har]);
    check('4a record session opens', !!openRec?.name, openRec?.error?.message || openRec?.name);
    gb(['goto', `${base}/thirdparty.html`, '-s', 'm13rec']);
    gb(['wait', '-s', 'm13rec', '--sleep', '1200']);
    const titleLive = gb(['eval', '-s', 'm13rec', '--expression', 'document.title']);
    check('4b third party reachable during record', titleLive?.value === 'items:3', String(titleLive?.value));
    gb(['session', 'rm', 'm13rec']);
    await delay(1200); // playwright writes the HAR on context close

    const entries = (() => { try { return JSON.parse(fs.readFileSync(har, 'utf8')).log.entries; } catch { return []; } })();
    const fontEntry = entries.find((e) => /f\.woff2/.test(e.request.url));
    check('4c HAR captured the third-party responses', entries.length >= 4, `${entries.length} entries`);
    check('4d HAR embeds the FONT BODY', !!fontEntry?.response?.content?.text,
      'this is the whole point — the bytes travel with the code, so text metrics stop being fiction');

    // Now the origin goes away. Requests to it fail the way an unreachable origin always fails.
    tp.kill();
    await delay(400);

    gb(['session', 'open', 'm13nohar']);
    gb(['goto', `${base}/thirdparty.html`, '-s', 'm13nohar']);
    const vNo = gb(['verify', '-s', 'm13nohar']);
    const outNo = gb(['eval', '-s', 'm13nohar', '--expression', "document.getElementById('out').textContent"]);
    check('4e without the HAR the page is broken', vNo?.counts?.netFailed > 0 && outNo?.value === 'api dead',
      `netFailed=${vNo?.counts?.netFailed} out=${outNo?.value}`);

    gb(['session', 'open', 'm13har', '--har', har]);
    gb(['goto', `${base}/thirdparty.html`, '-s', 'm13har']);
    gb(['wait', '-s', 'm13har', '--sleep', '800']);
    const vHar = gb(['verify', '-s', 'm13har']);
    const outHar = gb(['eval', '-s', 'm13har', '--expression', "document.getElementById('out').textContent"]);
    check('4f the HAR restores the app', vHar?.counts?.netFailed === 0 && outHar?.value === 'items:3',
      `netFailed=${vHar?.counts?.netFailed} out=${outHar?.value}`);
    check('4g conditions report fonts as har-replayed', vHar?.conditions?.fonts === 'har-replayed',
      `fonts=${vHar?.conditions?.fonts} stubs=${JSON.stringify(vHar?.conditions?.stubs)}`);
    // The replayed CSS brings a real low-contrast heading with it. The jailed run could not see it
    // at all — so the bridge does not merely silence noise, it restores findings.
    check('4h the HAR run SEES a defect the jailed run could not', (vHar?.counts?.layout || 0) > (vNo?.counts?.layout || 0),
      `layout: no-har=${vNo?.counts?.layout} with-har=${vHar?.counts?.layout}`);

    // ─── 5. Conditions block ────────────────────────────────────────────────────────────────
    const c = vHar?.conditions || {};
    check('5a every verify carries its conditions',
      !!c.platform && !!c.display && !!c.egress && !!c.fonts && !!c.load,
      JSON.stringify({ platform: c.platform, display: c.display, egress: c.egress, fonts: c.fonts, load: c.load }));
    check('5b findings are tagged with their portability',
      (vHar?.findings || []).every((f) => !!f.portability),
      [...new Set((vHar?.findings || []).map((f) => f.portability))].join(', '));
    const contrast = (vHar?.findings || []).find((f) => /contrast/i.test(f.summary));
    check('5c a contrast finding is portable',
      !contrast || contrast.portability === 'portable',
      'contrast is computed from CSS colour values, not from pixels, so it survives any renderer');

    // ─── 6. Human channel: export ───────────────────────────────────────────────────────────
    const exp = gb(['export', '-s', 'm13har']);
    check('6a export writes a file', !!exp?.path && fs.existsSync(exp.path), exp?.path || exp?.error?.message);
    if (exp?.path) {
      const html = fs.readFileSync(exp.path, 'utf8');
      const external = /(?:src|href)\s*=\s*["'](?!data:|#)(https?:)?\/\//i.test(html);
      check('6b export is SELF-CONTAINED', !external,
        'it has to open on a machine with no network and no glassbox — external refs would defeat that');
      check('6c export states the conditions', /Conditions this was measured under/.test(html) && html.includes(c.egress));
    }
    const htmlDirect = buildReportHtml({ ok: true, url: 'http://x/', conditions: { platform: 'sandbox' }, counts: {}, findings: [], artifacts: {} });
    check('6d report builder handles an empty report', htmlDirect.includes('<!doctype html>') && htmlDirect.includes('No findings'));

    // ─── 7. Lifecycle: the reaper must actually be able to look ─────────────────────────────
    // Before M13 these functions returned [] on Linux (they shelled out to powershell.exe), so the
    // suite's "0 strays" checks passed while browsers leaked. Asserting NON-zero with a browser up
    // is what makes the zero mean something.
    const live = listGlassboxChromium();
    check('7a the process reaper can see our chromium while one is running', live.length > 0,
      `${live.length} pids — a reaper that always answers "0" is worse than none`);

    gb(['kill-all', '--force']);
    await delay(1500);
    const after = listGlassboxChromium();
    check('7b kill-all --force actually reaps them', after.length === 0, `${after.length} left`);
  } finally {
    tp.kill();
    zoo.kill();
    try { fs.unlinkSync(har); } catch { /* gone */ }
    gb(['kill-all', '--force']);
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
