// Spike 2: white-box debug plane. While session A is PAUSED at a breakpoint:
//   - can we inspect call-frame locals? (Debugger.evaluateOnCallFrame)
//   - can we screenshot the frozen page? (Page.captureScreenshot)
//   - does an unrelated session B stay fully interactive?
// Then resume and confirm the handler completed.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Users/boomb/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const t0 = Date.now();
const stamp = () => `[+${String(Date.now() - t0).padStart(5)}ms]`;

const PAGE = `<!doctype html><title>dbg</title>
<button id="go" style="width:200px;height:60px">go</button>
<script>
  window.state = 'idle';
  document.getElementById('go').onclick = function handler() {
    const secret = 'local-var-42';
    window.state = 'clicked:' + secret;   // BREAKPOINT LINE (line 5, 0-indexed 4? see below)
  };
</script>`;
const server = createServer((_, res) => res.end(PAGE));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'gbx-'))}`,
  '--no-first-run', '--no-default-browser-check',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  proc.stderr.on('data', d => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error('launch timeout')), 15000);
});

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map();
const eventWaiters = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  } else {
    for (let i = eventWaiters.length - 1; i >= 0; i--) {
      const w = eventWaiters[i];
      if (w.method === msg.method && (!w.sessionId || w.sessionId === msg.sessionId)) {
        eventWaiters.splice(i, 1); w.resolve(msg.params);
      }
    }
  }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
});
const waitEvent = (method, sessionId, ms = 10000) => new Promise((resolve, reject) => {
  eventWaiters.push({ method, sessionId, resolve });
  setTimeout(() => reject(new Error('timeout: ' + method)), ms);
});

async function makeSession() {
  const { browserContextId } = await send('Target.createBrowserContext', {});
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  return sessionId;
}
const [A, B] = await Promise.all([makeSession(), makeSession()]);
const nav = async (s) => {
  const loaded = waitEvent('Page.loadEventFired', s);
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` }, s);
  await loaded;
};
await Promise.all([nav(A), nav(B)]);
const evalIn = async (s, expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true }, s)).result.value;

// --- arm the debugger in A ---------------------------------------------------
await send('Debugger.enable', {}, A);
// find the script and set a breakpoint on the window.state assignment line
const bp = await send('Debugger.setBreakpointByUrl', {
  lineNumber: 5, url: `http://127.0.0.1:${PORT}/`,
}, A);
console.log(stamp(), 'breakpoint set:', bp.breakpointId, 'locations:', bp.locations.length);

// trigger via a REAL compositor click (fire-and-forget so we don't deadlock)
const paused = waitEvent('Debugger.paused', A, 8000);
for (const type of ['mousePressed', 'mouseReleased']) {
  send('Input.dispatchMouseEvent', { type, x: 100, y: 30, button: 'left', clickCount: 1 }, A);
}
const pauseEv = await paused;
const frame = pauseEv.callFrames[0];
console.log(stamp(), `PAUSED in '${frame.functionName}' reason=${pauseEv.reason}`);

// 1. inspect a local variable on the paused frame
const local = await send('Debugger.evaluateOnCallFrame', {
  callFrameId: frame.callFrameId, expression: 'secret', returnByValue: true,
}, A);
console.log(stamp(), 'local var while paused: secret =', JSON.stringify(local.result.value));

// 2. screenshot the frozen page
try {
  const shot = await send('Page.captureScreenshot', { format: 'png' }, A);
  writeFileSync('C:/Users/boomb/Documents/_Projects/glassbox/spikes/paused-shot.png',
    Buffer.from(shot.data, 'base64'));
  console.log(stamp(), 'screenshot WHILE PAUSED: ok,', Math.round(shot.data.length * 0.75 / 1024) + 'KB');
} catch (e) {
  console.log(stamp(), 'screenshot while paused FAILED:', e.message);
}

// 3. is the sibling session still alive while A is paused?
const bTitle = await evalIn(B, 'document.title + "/" + (1 + 1)');
console.log(stamp(), 'session B while A paused:', bTitle, '<- unaffected');

// 4. resume, confirm handler ran to completion
const resumed = waitEvent('Debugger.resumed', A);
await send('Debugger.resume', {}, A);
await resumed;
const state = await evalIn(A, 'window.state');
console.log(stamp(), 'after resume: window.state =', JSON.stringify(state));

await send('Browser.close');
server.close();
await new Promise(r => proc.on('exit', r));
console.log(stamp(), 'clean shutdown');
