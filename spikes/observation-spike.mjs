// Spike 3: observation economics + ride-along channel, against a REAL page.
//   - How big is a full AXTree / DOMSnapshot of a production page? (token budget)
//   - Does Page.startScreencast deliver a usable live-view stream?
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Frozen research spike. Point GLASSBOX_CHROME at any Chromium binary to re-run it — e.g. the
// one `npx playwright install chromium` caches under %LOCALAPPDATA%\ms-playwright (or ~/.cache).
const CHROME = process.env.GLASSBOX_CHROME;
if (!CHROME) { console.error('spike: set GLASSBOX_CHROME to a chromium binary path'); process.exit(2); }
const URL_UNDER_TEST = 'https://wcii.pages.dev/';
const t0 = Date.now();
const stamp = () => `[+${String(Date.now() - t0).padStart(5)}ms]`;

const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'gbx-'))}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,800',
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
const listeners = new Map(); // method -> fn (persistent)
const eventWaiters = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  } else {
    listeners.get(msg.method)?.(msg.params, msg.sessionId);
    for (let i = eventWaiters.length - 1; i >= 0; i--) {
      const w = eventWaiters[i];
      if (w.method === msg.method) { eventWaiters.splice(i, 1); w.resolve(msg.params); }
    }
  }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
});
const waitEvent = (method, ms = 20000) => new Promise((resolve, reject) => {
  eventWaiters.push({ method, resolve });
  setTimeout(() => reject(new Error('timeout: ' + method)), ms);
});

const { browserContextId } = await send('Target.createBrowserContext', {});
const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, S);
await send('Runtime.enable', {}, S);
await send('Accessibility.enable', {}, S);
await send('DOM.enable', {}, S);

const loaded = waitEvent('Page.loadEventFired');
await send('Page.navigate', { url: URL_UNDER_TEST }, S);
await loaded;
await new Promise(r => setTimeout(r, 1500)); // let hydration settle
console.log(stamp(), 'loaded', URL_UNDER_TEST);

// ---- observation economics --------------------------------------------------
const est = s => Math.round(s.length / 4); // rough tokens

const ax = await send('Accessibility.getFullAXTree', {}, S);
const axRaw = JSON.stringify(ax.nodes);
const interesting = ax.nodes.filter(n =>
  !n.ignored && n.role?.value && !['none', 'generic', 'InlineTextBox', 'StaticText'].includes(n.role.value));
const axDistilled = interesting.map(n =>
  `${n.role.value}${n.name?.value ? ' "' + n.name.value + '"' : ''}`).join('\n');
console.log(stamp(), `AXTree: ${ax.nodes.length} nodes raw=${est(axRaw)}tok | ` +
  `distilled ${interesting.length} nodes=${est(axDistilled)}tok`);

const snap = await send('DOMSnapshot.captureSnapshot', {
  computedStyles: ['color', 'background-color', 'display', 'visibility', 'overflow'],
}, S);
console.log(stamp(), `DOMSnapshot(5 styles): ${est(JSON.stringify(snap))}tok raw`);

const html = await send('Runtime.evaluate',
  { expression: 'document.documentElement.outerHTML.length', returnByValue: true }, S);
console.log(stamp(), `outerHTML: ~${Math.round(html.result.value / 4)}tok raw`);

const shot = await send('Page.captureScreenshot', { format: 'webp', quality: 70 }, S);
console.log(stamp(), `screenshot webp q70: ${Math.round(shot.data.length * 0.75 / 1024)}KB`);

// ---- screencast as ride-along channel --------------------------------------
let frames = 0, bytes = 0;
listeners.set('Page.screencastFrame', (p, sid) => {
  frames++; bytes += p.data.length * 0.75;
  send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid);
});
await send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 960, maxHeight: 600 }, S);
// generate motion: scroll the page
for (let i = 0; i < 6; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: 0, deltaY: 300 }, S);
  await new Promise(r => setTimeout(r, 250));
}
await send('Page.stopScreencast', {}, S);
console.log(stamp(), `screencast: ${frames} frames in ~1.5s of scrolling, ` +
  `${Math.round(bytes / 1024)}KB total (~${Math.round(bytes / frames / 1024)}KB/frame)`);

writeFileSync(new URL('ax-distilled-sample.txt', import.meta.url),
  axDistilled.slice(0, 4000));
await send('Browser.close');
await new Promise(r => proc.on('exit', r));
console.log(stamp(), 'clean shutdown');
