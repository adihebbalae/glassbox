// Bug-zoo static server (arch/build-plan M8). A tiny dependency-free node http server that serves
// the seeded bug pages plus a few dynamic endpoints the pages need: a 500, a request that never
// responds ("hanging"), and a "bundled" JS with an INLINE source map (for the sourcemap-remap
// proof). Reusable by later milestones — import { startBugzoo } and drive it. Unknown paths 404.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

// A minimal, hand-authored source-map v3: the whole generated line 0 maps to original.ts line 4
// (mappings "AAGA" = one segment [genCol 0, source 0, origLine +3 → line 4 1-based, origCol 0]).
const MAP = { version: 3, sources: ['original.ts'], names: [], mappings: 'AAGA' };
const MAP_B64 = Buffer.from(JSON.stringify(MAP)).toString('base64');
// bundle.js: `boom()` throws on generated line 1; its frame must remap to original.ts:4.
const BUNDLE = `function boom(){throw new Error("SEED sourcemap boom");}\nboom();\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${MAP_B64}\n`;

/** Start the bug-zoo. Returns {server, base, port, close}. */
export function startBugzoo() {
  const hanging = new Set(); // sockets we deliberately never answer — destroyed on close()
  // Request counters behind a LONG cache lifetime: the only honest way to prove from the outside
  // whether a second navigation really re-fetched (defect round 2, W3 — the arch claims every tab
  // runs with `Network.setCacheDisabled(true)`, and that claim needed testing, not trusting).
  const counts = new Map();

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url.startsWith('/count/')) {
      const name = url.slice('/count/'.length);
      counts.set(name, (counts.get(name) || 0) + 1);
      res.writeHead(200, {
        'content-type': MIME[path.extname(name)] || 'text/plain',
        'cache-control': 'public, max-age=600', // aggressively cacheable ON PURPOSE
      });
      return res.end(path.extname(name) === '.css' ? `/* hit ${counts.get(name)} */` : `// hit ${counts.get(name)}`);
    }
    if (url === '/counts') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(Object.fromEntries(counts)));
    }
    if (url === '/reset-counts') {
      counts.clear();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end('{"ok":true}');
    }
    // A 404 favicon whose negative result the browser caches — the WCII dogfood's vanishing finding.
    if (url === '/favicon-404.ico') {
      counts.set('favicon', (counts.get('favicon') || 0) + 1);
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'public, max-age=600' });
      return res.end('no favicon');
    }

    // A real dev server answers the browser's automatic favicon probe (Vite/Astro 204 it); without
    // this the FIRST navigation to a fresh origin logs a spurious favicon 404 console error that is
    // a harness artifact, not a seeded bug. (Chrome caches the favicon result per-origin, so only a
    // session's first nav ever sees it — which is exactly the fresh-verify case.)
    if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url === '/api/500') { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('boom 500'); }
    if (url === '/api/ok') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (url === '/api/hang') { hanging.add(res); res.socket?.unref?.(); return; /* never responds */ }
    if (url === '/bundle.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(BUNDLE); }

    const name = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const file = path.join(DIR, name);
    if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    // M13: pages that reference a THIRD-PARTY origin can't hardcode its ephemeral port. The zoo
    // rewrites the placeholder at serve time from GLASSBOX_TP_BASE, so one fixture file serves both
    // the record leg (third party up) and the replay leg (third party down).
    if (path.extname(file) === '.html' && process.env.GLASSBOX_TP_BASE) {
      return res.end(fs.readFileSync(file, 'utf8').split('TP_BASE').join(process.env.GLASSBOX_TP_BASE));
    }
    res.end(fs.readFileSync(file));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => { for (const res of hanging) { try { res.destroy(); } catch { /* gone */ } } server.close(() => r()); }),
      });
    });
  });
}

// Allow `node test/bugzoo/serve.mjs` for manual poking.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  startBugzoo().then(({ base }) => console.log('bugzoo on', base));
}
