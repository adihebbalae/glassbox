// Spike: can we drive Playwright's cached Chromium with ZERO npm dependencies?
// Proves: launch, raw-CDP over Node's built-in WebSocket, two parallel isolated
// browser contexts, storage isolation, screenshots, and CSS cascade introspection.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Frozen research spike. Point GLASSBOX_CHROME at any Chromium binary to re-run it — e.g. the
// one `npx playwright install chromium` caches under %LOCALAPPDATA%\ms-playwright (or ~/.cache).
const CHROME = process.env.GLASSBOX_CHROME;
if (!CHROME) { console.error('spike: set GLASSBOX_CHROME to a chromium binary path'); process.exit(2); }
const t0 = Date.now();
const stamp = () => `[+${String(Date.now() - t0).padStart(5)}ms]`;

// -- tiny page under test -----------------------------------------------------
const PAGE = `<!doctype html><title>spike</title>
<style>.hero{background:#fff}.hero .cta{color:#fff;padding:8px}</style>
<div class="hero"><button class="cta">Invisible button</button></div>
<script>document.title = 'spike:' + location.search</script>`;
const server = createServer((_, res) => res.end(PAGE));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
console.log(stamp(), 'test server on', PORT);

// -- launch chromium ----------------------------------------------------------
const proc = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'gbx-'))}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('no DevTools banner in 15s: ' + buf)), 15000);
  proc.stderr.on('data', d => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) { clearTimeout(timer); resolve(m[1]); }
  });
  proc.on('exit', c => reject(new Error('chrome exited early: ' + c + ' ' + buf)));
});
console.log(stamp(), 'chromium up:', wsUrl.slice(0, 40) + '...');

// -- minimal CDP client (flatten-mode session multiplexing) -------------------
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
  setTimeout(() => reject(new Error('timeout waiting ' + method)), ms);
});

// -- two parallel isolated sessions ------------------------------------------
async function makeSession(tag) {
  const { browserContextId } = await send('Target.createBrowserContext', {});
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  console.log(stamp(), `session ${tag} ready (ctx ${browserContextId.slice(0, 8)})`);
  return sessionId;
}
const [A, B] = await Promise.all([makeSession('A'), makeSession('B')]);

const nav = async (s, q) => {
  const loaded = waitEvent('Page.loadEventFired', s);
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?${q}` }, s);
  await loaded;
};
await Promise.all([nav(A, 'A'), nav(B, 'B')]);

const evalIn = async (s, expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true }, s)).result.value;

// isolation proof: write storage+cookie in A, look for it in B
await evalIn(A, `localStorage.setItem('who','A'); document.cookie='who=A'; 'ok'`);
const leakLS = await evalIn(B, `localStorage.getItem('who')`);
const leakCk = await evalIn(B, `document.cookie`);
const titleA = await evalIn(A, `document.title`);
const titleB = await evalIn(B, `document.title`);
console.log(stamp(), `titles: A='${titleA}' B='${titleB}' | leak into B: localStorage=${JSON.stringify(leakLS)} cookie='${leakCk}'`);

// screenshot proof
const shot = await send('Page.captureScreenshot', { format: 'png' }, A);
const outPng = new URL('spike-shot.png', import.meta.url);
writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
console.log(stamp(), `screenshot: ${Math.round(shot.data.length * 0.75 / 1024)}KB -> spike-shot.png`);

// cascade introspection proof: WHY is .cta white?
await send('DOM.enable', {}, A);
await send('CSS.enable', {}, A);
const { root } = await send('DOM.getDocument', {}, A);
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '.cta' }, A);
const styles = await send('CSS.getMatchedStylesForNode', { nodeId }, A);
const colorRule = styles.matchedCSSRules?.find(r =>
  r.rule.style.cssProperties.some(p => p.name === 'color'));
const bgParent = styles.inherited?.length ?? 0;
console.log(stamp(), `cascade: .cta color set by selector '${colorRule?.rule.selectorList.text}' ` +
  `(${colorRule?.rule.style.cssProperties.find(p => p.name === 'color').value}), ` +
  `${styles.matchedCSSRules.length} matched rules, ${bgParent} inherited entries`);

// contrast check the agent could compute: fg vs effective bg
const contrast = await evalIn(A, `
  const el = document.querySelector('.cta');
  const fg = getComputedStyle(el).color;
  let bg = 'transparent', n = el;
  while (n && (bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)'))
    { bg = getComputedStyle(n).backgroundColor; n = n.parentElement; }
  fg + ' on ' + bg`);
console.log(stamp(), 'computed contrast pair:', contrast, '<- white-on-white detectable');

await send('Browser.close');
server.close();
await new Promise(r => proc.on('exit', r));
console.log(stamp(), 'clean shutdown. exit code:', proc.exitCode);
