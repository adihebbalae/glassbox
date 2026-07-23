// The daemon-served ride-along UI (arch §7): a session grid at GET / and a live watcher at
// GET /watch/:session. Single self-contained HTML string each — inline CSS/JS, zero deps, dark and
// minimal. The watcher renders the JPEG screencast stream onto a <canvas> (createImageBitmap),
// forwards click/key/scroll as takeover (scaling display px → frame CSS px), shows a PAUSED badge
// from frame metadata, a connection-state dot, and an fps counter. The "real DevTools" affordance is
// a documented paste-into-a-Chrome-tab devtools:// link (we do NOT vendor devtools-frontend).
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 :root{color-scheme:dark}
 *{box-sizing:border-box}
 body{margin:0;background:#0b0d10;color:#c9d1d9;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
 a{color:#58a6ff;text-decoration:none} a:hover{text-decoration:underline}
 header{display:flex;align-items:center;gap:12px;padding:8px 12px;background:#11151a;border-bottom:1px solid #21262d}
 .dot{width:9px;height:9px;border-radius:50%;background:#8b949e;display:inline-block}
 .dot.live{background:#3fb950}.dot.closed{background:#f85149}.dot.wait{background:#d29922}
 .badge{padding:1px 8px;border-radius:10px;background:#21262d;font-size:12px}
 .paused{background:#9e6a03;color:#fff;display:none}
 .muted{color:#8b949e}
</style>`;

/** GET / — the session grid. Renders current sessions; the page reloads itself every 5s. */
export function gridPage({ token, sessions = [] }) {
  const rows = sessions.length
    ? sessions.map((s) => {
      const href = `/watch/${encodeURIComponent(s.name)}?token=${encodeURIComponent(token)}`;
      return `<tr><td><a href="${esc(href)}">${esc(s.name)}</a></td>`
        + `<td class="muted">${s.headed ? 'headed' : 'headless'}</td>`
        + `<td class="muted">${esc(s.url || '-')}</td>`
        + `<td class="muted">idle ${Math.round((s.idleMs || 0) / 1000)}s</td></tr>`;
    }).join('')
    : '<tr><td colspan="4" class="muted">no sessions — open one with `glassbox session open &lt;name&gt;`</td></tr>';
  return `<!doctype html><html><head><title>glassbox — sessions</title>${HEAD}</head><body>
<header><strong>glassbox</strong><span class="muted">ride-along session grid</span></header>
<table style="width:100%;border-collapse:collapse">
<thead><tr class="muted"><th align="left" style="padding:6px 12px">session</th><th align="left">mode</th><th align="left">url</th><th align="left">idle</th></tr></thead>
<tbody>${rows}</tbody></table>
<script>setTimeout(function(){location.reload();},5000);</script>
</body></html>`;
}

/** GET /watch/:session — the live canvas viewer + takeover. */
export function watchPage({ session, token, cdp }) {
  const boot = JSON.stringify({ session, token, cdp: cdp || null });
  return `<!doctype html><html><head><title>watch ${esc(session)}</title>${HEAD}</head><body>
<header>
 <span class="dot wait" id="dot"></span>
 <strong id="title">watch: ${esc(session)}</strong>
 <span class="badge paused" id="paused">PAUSED</span>
 <span class="muted" id="fps">– fps</span>
 <span class="muted" id="dims"></span>
 <span style="flex:1"></span>
 <a href="/?token=${esc(token)}">&larr; grid</a>
</header>
<div style="padding:10px">
 <canvas id="cv" tabindex="0" style="max-width:100%;height:auto;background:#000;border:1px solid #21262d;cursor:crosshair;outline:none"></canvas>
 <div class="muted" style="margin-top:8px">click / type / scroll on the canvas to take over &mdash; a paused page won't react until you resume.</div>
 <div id="dt" class="muted" style="margin-top:10px"></div>
</div>
<script>
const BOOT = ${boot};
const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const dot = document.getElementById('dot'), pausedEl = document.getElementById('paused');
const fpsEl = document.getElementById('fps'), dimsEl = document.getElementById('dims');
let last = { w: 0, h: 0, paused: false }, fpsCount = 0;
setInterval(function(){ fpsEl.textContent = fpsCount + ' fps'; fpsCount = 0; }, 1000);

if (BOOT.cdp && BOOT.cdp.devtoolsFrontend) {
  const dt = document.getElementById('dt');
  dt.innerHTML = 'real DevTools: paste into a Chrome address bar &rarr; '
    + '<span style="user-select:all;color:#c9d1d9">' + BOOT.cdp.devtoolsFrontend.replace(/[&<>]/g, function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}) + '</span>';
}

function proto(){ return location.protocol === 'https:' ? 'wss:' : 'ws:'; }
const url = proto() + '//' + location.host + '/watch/' + encodeURIComponent(BOOT.session) + '?token=' + encodeURIComponent(BOOT.token);
const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';
ws.onopen = function(){ dot.className = 'dot live'; };
ws.onclose = function(){ dot.className = 'dot closed'; };
ws.onerror = function(){ dot.className = 'dot closed'; };
ws.onmessage = async function(ev){
  if (typeof ev.data === 'string') return;
  const buf = ev.data, dv = new DataView(buf);
  const metaLen = dv.getUint32(0, true);
  let meta; try { meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, metaLen))); } catch(e){ return; }
  const jpeg = new Uint8Array(buf, 4 + metaLen);
  last = meta;
  try {
    const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
    if (cv.width !== bmp.width) cv.width = bmp.width;
    if (cv.height !== bmp.height) cv.height = bmp.height;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
  } catch(e){ /* skip a bad frame */ }
  pausedEl.style.display = meta.paused ? 'inline-block' : 'none';
  dimsEl.textContent = meta.w + '×' + meta.h;
  fpsCount++;
};

function frameCoords(e){
  const r = cv.getBoundingClientRect();
  const fx = r.width ? (e.clientX - r.left) / r.width : 0;
  const fy = r.height ? (e.clientY - r.top) / r.height : 0;
  return { x: Math.round(fx * (last.w || 0)), y: Math.round(fy * (last.h || 0)) };
}
function send(o){ if (ws.readyState === 1) ws.send(JSON.stringify(o)); }

cv.addEventListener('click', function(e){ cv.focus(); const c = frameCoords(e); send({ type: 'click', x: c.x, y: c.y }); });
cv.addEventListener('wheel', function(e){ e.preventDefault(); const c = frameCoords(e); send({ type: 'scroll', x: c.x, y: c.y, dy: e.deltaY }); }, { passive: false });
cv.addEventListener('keydown', function(e){
  e.preventDefault();
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  send({ type: 'key', key: e.key, text: printable ? e.key : undefined });
});
</script>
</body></html>`;
}
