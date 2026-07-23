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

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

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
