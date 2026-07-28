// A stand-in for "the internet" — the origins a sandboxed browser cannot reach.
//
// Used two ways by test/m13.mjs:
//   1. RECORD leg: reachable, so a HAR can be captured against it (the "networked machine").
//   2. REPLAY leg: shut down, so requests to it fail exactly the way the sandbox egress proxy makes
//      them fail — which is what the fifth network bucket has to classify correctly.
//
// Cross-origin fonts are CORS-restricted, so the ACAO header is not decoration: without it the
// font silently never loads and the HAR records a pending request with status -1. That is a real
// trap when recording a HAR against a real site, and it is why the recording leg asserts on
// response status rather than on entry count.
import http from 'node:http';

// A minimal but structurally valid WOFF2 header. Nothing renders it; the assertions are about
// whether the bytes survive the record → replay round trip.
const WOFF2 = Buffer.from('d9ff54ff000000240000000000000000000000000000', 'hex');

export function startThirdParty(port = 0) {
  const server = http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'no-store');
    const url = req.url || '/';
    if (url.startsWith('/css')) {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('@font-face{font-family:Recorded;src:url(/f.woff2) format("woff2")}\n.tp{color:#0a7}');
    }
    if (url.startsWith('/f.woff2')) {
      res.writeHead(200, { 'content-type': 'font/woff2' });
      return res.end(WOFF2);
    }
    if (url.startsWith('/api')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ items: [1, 2, 3] }));
    }
    res.writeHead(404);
    res.end('nf');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({ server, port: p, base: `http://127.0.0.1:${p}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startThirdParty(Number(process.argv[2]) || 0).then((s) => console.log(s.base));
}
