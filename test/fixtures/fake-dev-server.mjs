#!/usr/bin/env node
// A throwaway stand-in for a Vite/Astro dev server, for the M7 proof — zero deps, no npm install,
// nothing to keep in sync with a real framework. It mimics exactly the three things `glassbox dev`
// consumes:
//   (a) an ANSI-colored ready banner on stdout ~300ms after listen (Vite's real banner shape, so
//       the URL regex has to strip escapes and skip the non-URL "ready in 312 ms" line first),
//   (b) a clean page to attach to (so the first verify is a true ok:true, not a false-positive
//       flood),
//   (c) a rebuild trigger: POST /rebuild prints an HMR line ("hmr update … updated in 123ms") and
//       flips server state to "build error"; POST /fix clears it.
//
// The page carries a stand-in HMR client that POLLS /state every 1.5s rather than opening a
// WebSocket/EventSource — research 07 §1 says the HMR socket is an internal channel Glassbox must
// never depend on, and a slow poll leaves the in-flight low-water gaps `settle` needs. When the
// state says "error" it injects Vite's REAL overlay markup: a <vite-error-overlay> element with an
// OPEN shadow root containing .message-body / .file / .frame (research 07 §2) — which is what
// src/daemon/overlay-reader.mjs reads through.
import http from 'node:http';

const ESC = String.fromCharCode(27);
const c = (code, s) => `${ESC}[${code}m${s}${ESC}[0m`;

const SEED_ERROR = {
  plugin: 'vite:import-analysis',
  message: 'Failed to parse source for import analysis because the content contains invalid JS syntax. GBX-SEED-OVERLAY',
  file: '/src/App.jsx:12:3',
  frame: '10 |  export default function App() {\n11 |    return (\n12 |      <div>\n   |      ^',
};

let state = { error: null };

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>fake dev server</title>
<style>
  body { font-family: sans-serif; color: #111111; background: #ffffff; margin: 16px; }
  button { min-width: 44px; min-height: 44px; color: #111111; background: #eeeeee; border: 1px solid #888; }
</style>
</head>
<body>
<header><h1>fake dev server</h1></header>
<main>
  <p>Stands in for a Vite/Astro dev server: clean until POST /rebuild seeds a build error, which
     this page renders in the same open-shadow-DOM overlay Vite ships.</p>
  <button id="go" type="button">A perfectly normal button</button>
</main>
<script>
(function () {
  var shown = null;
  function clear() { var e = document.querySelector('vite-error-overlay'); if (e) e.remove(); }
  function show(err) {
    var el = document.createElement('vite-error-overlay');
    var sr = el.attachShadow({ mode: 'open' });
    sr.innerHTML = '<style>.window{position:fixed;top:0;left:0;right:0;bottom:0;background:#181818;'
      + 'color:#ff5555;padding:24px;font:13px monospace;overflow:auto;z-index:99999}</style>'
      + '<div class="window"><pre class="message"><span class="plugin"></span>'
      + '<span class="message-body"></span></pre><pre class="file"></pre><pre class="frame"></pre>'
      + '<pre class="stack"></pre></div>';
    sr.querySelector('.plugin').textContent = err.plugin ? '[plugin:' + err.plugin + '] ' : '';
    sr.querySelector('.message-body').textContent = err.message;
    sr.querySelector('.file').textContent = err.file || '';
    sr.querySelector('.frame').textContent = err.frame || '';
    document.body.appendChild(el);
  }
  function tick() {
    fetch('/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
      var key = s.error ? s.error.message : '';
      if (key === shown) return;
      shown = key;
      clear();
      if (s.error) show(s.error);
    }).catch(function () { /* server going away */ });
  }
  setInterval(tick, 1500);
})();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (url === '/state') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(state));
  }
  if (url === '/rebuild') {
    state = { error: SEED_ERROR };
    // Vite's own HMR log shape — this is the line `glassbox dev` regexes as a rebuild.
    console.log(`${c(36, '8:01:23 PM')} ${c(1, '[vite]')} ${c(32, 'hmr update /src/App.jsx')} updated in 123ms`);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true,"error":true}');
  }
  if (url === '/fix') {
    state = { error: null };
    console.log(`${c(36, '8:01:31 PM')} ${c(1, '[vite]')} ${c(32, 'page reload src/App.jsx')}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true,"error":false}');
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// Bind loopback only (research 07 §7 — never trip the Windows Firewall prompt in a test), and
// print 127.0.0.1 rather than localhost so the banner URL is guaranteed to be the bound address
// (localhost can resolve to ::1 first on Windows). The localhost/ANSI form of the banner is
// covered by the pure findUrl() checks in test/m7.mjs.
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  // Announce our own PID so the proof can assert the tree really died by explicit PID (research
  // 07 §5: an explicit PID list beats tree/cmdline discovery) rather than by process enumeration.
  console.log(`[fixture] pid ${process.pid}`);
  setTimeout(() => {
    console.log('');
    console.log(`  ${c(32, 'VITE v6.0.0')}  ${c(2, 'ready in 312 ms')}`);
    console.log('');
    console.log(`  ${c(32, '->')}  ${c(1, 'Local')}:   ${c(36, `http://127.0.0.1:${port}/`)}`);
    console.log(`  ${c(32, '->')}  ${c(1, 'Network')}: use ${c(1, '--host')} to expose`);
  }, 300);
});

const bye = () => { try { server.close(); } catch { /* already down */ } process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
