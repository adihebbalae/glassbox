// M5 proof: the MCP shim + full CLI + new daemon routes. Two halves:
//   (a) spawn the shim as a child (`glassbox mcp`) and drive a FULL MCP conversation over stdio:
//       initialize → initialized → tools/list (14 tools, each with description + inputSchema) →
//       tools/call gb_session open → gb_goto (bug-zoo clean page) → gb_verify (ok:true) →
//       gb_observe → gb_act click → gb_read console → gb_screenshot (path exists on disk) →
//       gb_debug state (paused:false) → a BAD call (gb_act on a missing session → isError with the
//       valid session names in the text) → gb_session close → clean shutdown on stdin EOF.
//       PROTOCOL PURITY: every stdout line is valid JSON-RPC with a matching id; no stray garbage.
//   (b) the new daemon routes over plain HTTP: eval returns a value + captured console; screenshot
//       selector-clip writes a file; wait matches a present selector and returns matched:false
//       (no throw) for an absent one; artifacts lists ≥1 shot.
// kill-all + zero-orphan check at the end. Run: `node test/m5.mjs`.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS, daemonReq } from '../src/protocol.mjs';
import { listGlassboxChromium } from '../src/daemon/prockit.mjs';
import { startBugzoo } from './bugzoo/serve.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(args, timeout = 60000) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout, env: { ...process.env, GLASSBOX_NO_OPEN: '1' } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function readD() { try { return JSON.parse(fs.readFileSync(PATHS.daemonFile, 'utf8')); } catch { return null; } }

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---- a tiny MCP client over the shim's stdio (newline-delimited JSON-RPC) ----
function spawnShim() {
  const child = spawn(process.execPath, [CLI, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GLASSBOX_NO_OPEN: '1' } });
  const pending = new Map();
  const stdoutLines = [];
  const badLines = [];
  let buf = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      stdoutLines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { badLines.push(line); continue; }
      if (msg.jsonrpc !== '2.0') badLines.push(line);
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => { /* diagnostics — kept off the protocol stream, intentionally ignored */ });
  const request = (method, params) => {
    const id = nextId++;
    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('rpc timeout: ' + method)); } }, 130000);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    return p.then((msg) => ({ id, msg }));
  };
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
  const exit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, request, notify, stdoutLines, badLines, exit, endStdin: () => child.stdin.end() };
}

// pull the {type:'text'} content out of a tools/call result
const textOf = (msg) => (msg.result?.content || []).map((c) => c.text || '').join('\n');
const isErr = (msg) => msg.result?.isError === true;

let zoo;
async function run() {
  zoo = await startBugzoo();
  const base = zoo.base;

  cli(['kill-all']);
  await delay(500);
  check('1 precondition clean', !fs.existsSync(PATHS.daemonFile) && listGlassboxChromium().length === 0,
    `chromium ${listGlassboxChromium().length}`);

  // ===== (a) MCP conversation over stdio ======================================
  const shim = spawnShim();

  const init = await shim.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'm5-test', version: '0' } });
  check('a1 initialize → protocol + serverInfo glassbox', init.msg.result?.serverInfo?.name === 'glassbox'
    && init.msg.result?.protocolVersion === '2025-06-18' && !!init.msg.result?.capabilities?.tools && init.msg.id === init.id,
    `proto=${init.msg.result?.protocolVersion} server=${init.msg.result?.serverInfo?.name}`);

  shim.notify('notifications/initialized');

  const list = await shim.request('tools/list');
  const tools = list.msg.result?.tools || [];
  const allShaped = tools.every((t) => t.name && typeof t.description === 'string' && t.description.length > 0 && t.inputSchema && t.inputSchema.type === 'object');
  const names = tools.map((t) => t.name);
  const expected = ['gb_session', 'gb_goto', 'gb_act', 'gb_observe', 'gb_read', 'gb_verify', 'gb_screenshot', 'gb_style', 'gb_eval', 'gb_wait', 'gb_debug', 'gb_coverage', 'gb_dialog', 'gb_watch'];
  check('a2 tools/list → exactly 14 tools, each with description + inputSchema', tools.length === 14 && allShaped && expected.every((n) => names.includes(n)),
    `count=${tools.length} shaped=${allShaped} missing=${expected.filter((n) => !names.includes(n)).join(',') || 'none'}`);

  const open = await shim.request('tools/call', { name: 'gb_session', arguments: { op: 'open', name: 'm5' } });
  const openText = textOf(open.msg);
  check('a3 gb_session open → not isError, returns a watch URL + hint', !isErr(open.msg) && /watchUrl/.test(openText) && /\/watch\/m5\?token=/.test(openText),
    `err=${isErr(open.msg)} watch=${/\/watch\/m5/.test(openText)}`);

  const goto = await shim.request('tools/call', { name: 'gb_goto', arguments: { session: 'm5', url: base + '/clean.html' } });
  check('a4 gb_goto → settled delta, not isError', !isErr(goto.msg) && /"ok":true/.test(textOf(goto.msg)), textOf(goto.msg).slice(0, 80));

  const verify = await shim.request('tools/call', { name: 'gb_verify', arguments: { session: 'm5' } });
  check('a5 gb_verify → ok:true on the clean page', !isErr(verify.msg) && /"ok":true/.test(textOf(verify.msg)), textOf(verify.msg).slice(0, 100));

  const obs = await shim.request('tools/call', { name: 'gb_observe', arguments: { session: 'm5' } });
  check('a6 gb_observe → text tree with a ref + button', !isErr(obs.msg) && /e\d+\s+button/i.test(textOf(obs.msg)), textOf(obs.msg).split('\n')[0]);

  const clickR = await shim.request('tools/call', { name: 'gb_act', arguments: { session: 'm5', action: 'click', selector: '#go' } });
  check('a7 gb_act click by selector → not isError', !isErr(clickR.msg) && /"ok":true/.test(textOf(clickR.msg)), textOf(clickR.msg).slice(0, 60));

  const readR = await shim.request('tools/call', { name: 'gb_read', arguments: { session: 'm5', channel: 'console' } });
  check('a8 gb_read console → not isError', !isErr(readR.msg) && /"channel":"console"/.test(textOf(readR.msg)), textOf(readR.msg).slice(0, 60));

  const shotR = await shim.request('tools/call', { name: 'gb_screenshot', arguments: { session: 'm5' } });
  let shotPath = '';
  try { shotPath = JSON.parse(textOf(shotR.msg)).path || ''; } catch { /* leave blank */ }
  check('a9 gb_screenshot → returns a PATH that exists on disk (not inline bytes)', !isErr(shotR.msg) && !!shotPath && fs.existsSync(shotPath),
    `path=${shotPath ? '…' + shotPath.slice(-28) : '(none)'} exists=${shotPath && fs.existsSync(shotPath)}`);

  const dbgState = await shim.request('tools/call', { name: 'gb_debug', arguments: { session: 'm5', op: 'state' } });
  check('a10 gb_debug state → paused:false', !isErr(dbgState.msg) && /"paused":false/.test(textOf(dbgState.msg)), textOf(dbgState.msg).slice(0, 60));

  const bad = await shim.request('tools/call', { name: 'gb_act', arguments: { session: 'ghost', action: 'click', selector: '#go' } });
  const badText = textOf(bad.msg);
  check('a11 bad session → isError AND text lists valid session names (self-correcting)',
    isErr(bad.msg) && /NO_SESSION/.test(badText) && /m5/.test(badText),
    `isError=${isErr(bad.msg)} hasM5=${/m5/.test(badText)}`);

  const closeR = await shim.request('tools/call', { name: 'gb_session', arguments: { op: 'close', name: 'm5' } });
  check('a12 gb_session close → not isError', !isErr(closeR.msg) && /"name":"m5"/.test(textOf(closeR.msg)), textOf(closeR.msg).slice(0, 60));

  // protocol purity + graceful shutdown on stdin EOF
  check('a13 protocol purity: every stdout line was valid JSON-RPC 2.0 (no interleaved garbage)', shim.badLines.length === 0,
    `lines=${shim.stdoutLines.length} bad=${shim.badLines.length}`);
  shim.endStdin();
  const exitCode = await Promise.race([shim.exit, delay(8000).then(() => 'timeout')]);
  check('a14 shim exits cleanly on stdin EOF', exitCode === 0, `exit=${exitCode}`);

  // ===== (b) the new daemon routes over plain HTTP ============================
  const d = readD();
  check('b0 daemon still live (shim auto-started it)', !!d, `daemon=${!!d}`);
  if (!d) return;
  const post = (s, verb, body, ms) => daemonReq(d, 'POST', `/sessions/${s}/${verb}`, body || {}, ms);
  const act = async (s, verb, body, ms) => (await post(s, verb, body, ms)).body;

  await daemonReq(d, 'POST', '/sessions', { name: 'ex' });
  await act('ex', 'goto', { url: base + '/clean.html' }, 30000);

  // eval: value + captured console
  const ev = await act('ex', 'eval', { expression: "console.log('gbx-eval-log'); 40 + 2" });
  const evLog = (ev.console || []).some((c) => /gbx-eval-log/.test(c.text || ''));
  check('b1 eval returns the value AND captures console emitted during eval', ev.ok && ev.value === 42 && evLog,
    `value=${ev.value} type=${ev.type} console=${(ev.console || []).map((c) => c.text).join('|')}`);

  // screenshot selector-clip writes a file with sane dims
  const sc = await act('ex', 'screenshot', { selector: '#go' });
  check('b2 screenshot selector-clip writes a file (path exists, dims > 0)', sc.ok && fs.existsSync(sc.path) && sc.bytes > 0 && sc.w > 0 && sc.h > 0,
    `path=…${(sc.path || '').slice(-24)} bytes=${sc.bytes} ${sc.w}x${sc.h}`);

  // wait: present selector matched, absent selector matched:false without throwing
  const w1 = await post('ex', 'wait', { for: { selector: '#go' }, timeoutMs: 3000 });
  const w2 = await post('ex', 'wait', { for: { selector: '#definitely-not-here-zzz' }, timeoutMs: 800 });
  check('b3 wait matches a present selector', w1.status === 200 && w1.body.matched === true, `status=${w1.status} matched=${w1.body.matched}`);
  check('b4 wait on an absent selector → matched:false, NO throw (status 200)', w2.status === 200 && w2.body.matched === false,
    `status=${w2.status} matched=${w2.body.matched}`);

  // artifacts lists ≥1 shot (we just took one)
  const arts = await daemonReq(d, 'GET', '/sessions/ex/artifacts');
  const shots = arts.body?.artifacts?.shots || [];
  check('b5 artifacts lists ≥1 shot grouped by kind', arts.status === 200 && shots.length >= 1 && shots[0].rel && shots[0].bytes > 0,
    `shots=${shots.length} kinds=${Object.keys(arts.body?.artifacts || {}).join(',')}`);

  // ===== teardown ============================================================
  const before = listGlassboxChromium().length;
  cli(['--json', 'kill-all']);
  await delay(700);
  const after = listGlassboxChromium().length;
  check('c1 kill-all removes daemon.json', !fs.existsSync(PATHS.daemonFile));
  check('c2 kill-all leaves zero chromium strays', after === 0, `chromium ${before} -> ${after}`);
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
