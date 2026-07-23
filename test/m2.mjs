// M2 proof: act + observe — grounding, settling, deltas. Serves a local test page (node http,
// like the spikes) that exercises every M2 promise: a DOM-mutating button, a form, a delayed-JS
// page (content injected after a slow fetch — proves composite settle WAITS), an un-ARIA'd
// <div onclick> (proves the no-ax flag), a confirm() dialog (proves non-hang + respond), and a
// re-rendering list (proves the stale-ref round-trip). Cold-starts the daemon via the CLI, then
// drives it over HTTP like m1; kill-all + zero-orphan check at the end. Run: `node test/m2.mjs`.
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS, daemonReq } from '../src/protocol.mjs';
import { listGlassboxChromium } from '../src/daemon/prockit.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset=utf8><title>M2</title>
<h1>M2 test page</h1>
<button id=mutate>Add item</button>
<form id=f><input id=name aria-label=name><button type=submit>Go</button></form>
<div id=out role=status></div>
<div id=clickdiv onclick="document.getElementById('clickout').textContent='divclicked'">Click me (div)</div>
<div id=clickout></div>
<button id=dialogbtn onclick="if(confirm('Proceed?'))document.getElementById('out').textContent='confirmed'">Ask</button>
<button id=rerender>Rerender list</button>
<ul id=list><li><button class=item>Item 1</button></li><li><button class=item>Item 2</button></li></ul>
<script>
document.getElementById('mutate').onclick=function(){var li=document.createElement('li');li.textContent='added';document.getElementById('list').appendChild(li);};
document.getElementById('f').onsubmit=function(e){e.preventDefault();document.getElementById('out').textContent='submitted:'+document.getElementById('name').value;return false;};
document.getElementById('rerender').onclick=function(){document.getElementById('list').innerHTML='<li><button class=item>Item A</button></li><li><button class=item>Item B</button></li>';};
</script>`;

const DELAYED = `<!doctype html><meta charset=utf8><title>delayed</title>
<script>fetch('/slow').then(function(r){return r.text();}).then(function(t){var p=document.createElement('p');p.id='late';p.textContent=t;document.body.appendChild(p);});</script>
<h1>delayed</h1>`;

function serve() {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('LATE'); }, 1200); return; }
    if (req.url.startsWith('/delayed')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(DELAYED); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

function cli(args, timeout = 30000) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function readD() { try { return JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8')); } catch { return null; } }

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

let httpd;
async function run() {
  const s = await serve();
  httpd = s.server;
  const base = s.base;

  cli(['kill-all']);
  await delay(500);
  check('1 precondition clean', !fs.existsSync(PATHS.daemonFile) && listGlassboxChromium().length === 0,
    `chromium ${listGlassboxChromium().length}`);

  // 2 — cold CLI open auto-starts the daemon
  const r2 = cli(['--json', 'session', 'open', 'a']);
  const d = readD();
  check('2 cold CLI open auto-starts daemon', r2.status === 0 && !!d, `exit=${r2.status}`);
  if (!d) return;
  const act = async (verb, body) => (await daemonReq(d, 'POST', `/sessions/a/${verb}`, body || {})).body;
  const actRaw = (verb, body) => daemonReq(d, 'POST', `/sessions/a/${verb}`, body || {});

  // 3 — goto the local page; settle reports settled
  const g = await act('goto', { url: base + '/' });
  check('3 goto + settle', g.ok === true && g.settled === true && g.url.startsWith(base), `settled=${g.settled} why=${JSON.stringify(g.settleWhy)}`);

  // 4 — SELECTOR-FIRST: click by CSS with NO prior observe (registry empty), DOM mutates
  const c4 = await act('click', { selector: '#mutate' });
  check('4 selector-first click (no observe) + mutation delta', c4.ok === true && c4.mutations > 0, `mutations=${c4.mutations} settled=${c4.settled}`);

  // 5 — observe: text tree has real roles AND the un-ARIA'd div is flagged no-ax
  const o5 = await act('observe', {});
  const hasNoAx = (o5.nodes || []).some((n) => (n.flags || []).includes('no-ax'));
  check('5 observe distilled tree + no-ax flag', o5.ok && /button/.test(o5.text) && /textbox/.test(o5.text) && hasNoAx,
    `nodes=${o5.count} noax=${hasNoAx}`);

  // 6 — type + submit (fill semantics + Enter), form handler writes into the status region
  await act('type', { selector: '#name', text: 'hello', submit: true });
  const o6 = await act('observe', {});
  check('6 type+submit reaches the form handler', /submitted:hello/.test(o6.text), `out present=${/submitted:hello/.test(o6.text)}`);

  // 7 — settle WAITS for delayed JS (content injected only after a ~1.2s fetch)
  const t0 = Date.now();
  const g7 = await act('goto', { url: base + '/delayed' });
  const waited = Date.now() - t0;
  const o7 = await act('observe', {});
  check('7 settle waits for delayed-fetch content', waited >= 1000 && /LATE/.test(o7.text),
    `waited=${waited}ms tookMs=${g7.tookMs} late=${/LATE/.test(o7.text)}`);

  // 8 — back to the main page for the dialog + stale-ref scenarios
  await act('goto', { url: base + '/' });

  // 9 — confirm() dialog: the triggering click returns FAST with the dialog surfaced (no hang),
  //     a second action is refused with DIALOG_PENDING, then respond + a normal action works.
  const t9 = Date.now();
  const c9 = await act('click', { selector: '#dialogbtn' });
  const dt = Date.now() - t9;
  const pend = await actRaw('click', { selector: '#mutate' }); // should be refused while dialog pending
  const dresp = await act('dialog', { action: 'accept' });
  const after = await act('click', { selector: '#mutate' }); // works again once resolved
  check('9 dialog non-hang + surface + respond', dt < 4000 && c9.dialog?.type === 'confirm'
    && pend.status === 409 && pend.body.error?.code === 'DIALOG_PENDING' && dresp.ok === true && after.ok === true,
    `dt=${dt}ms surfaced=${c9.dialog?.type} pending=${pend.body.error?.code} after=${after.ok}`);

  // 10 — stale-ref round-trip: observe → act on an item ref → rerender (mutates) → old ref dies →
  //      STALE_REF → re-observe → new ref works.
  const o10 = await act('observe', {});
  const item = (o10.nodes || []).find((n) => /^Item/.test(n.name || ''));
  const okBefore = await actRaw('click', { ref: item?.ref });          // fresh ref works
  await act('click', { selector: '#rerender' });                        // rebuild the list (mutation)
  const stale = await actRaw('click', { ref: item?.ref });             // same ref, now stale
  const o10b = await act('observe', {});                                // re-observe
  const item2 = (o10b.nodes || []).find((n) => /^Item/.test(n.name || ''));
  const okAfter = await actRaw('click', { ref: item2?.ref });         // new ref works
  check('10 stale-ref round-trip (fresh ok → mutate → STALE_REF → re-observe → ok)',
    okBefore.status === 200 && stale.status === 409 && stale.body.error?.code === 'STALE_REF' && okAfter.status === 200,
    `ref=${item?.ref} before=${okBefore.status} stale=${stale.body.error?.code} newRef=${item2?.ref} after=${okAfter.status}`);

  // 11 — CLI action path (observe via the `glassbox` bin), then teardown with zero orphans
  const cliObs = cli(['observe', '-s', 'a']);
  check('11 CLI observe verb', cliObs.status === 0 && /e\d+ /.test(cliObs.stdout), `exit=${cliObs.status}`);

  const before = listGlassboxChromium().length;
  cli(['--json', 'kill-all']);
  await delay(600);
  const orphans = listGlassboxChromium().length;
  check('12a kill-all removes daemon.json', !fs.existsSync(PATHS.daemonFile));
  check('12b kill-all leaves zero chromium strays', orphans === 0, `chromium ${before} -> ${orphans}`);
}

function finish() {
  try { httpd?.close(); } catch { /* already closed */ }
  cli(['kill-all']);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
  console.log('FAIL  harness threw —', e?.stack || e);
  results.push({ name: 'harness', pass: false });
}).finally(finish);
