// Artifact export — the sandbox's human channel.
//
// On a developer's own machine, `glassbox watch` is how a person sees what the instrument sees: a
// live screencast on loopback they can click into. In a container nobody can reach loopback, so
// that whole channel is gone and there is no engineering that brings it back.
//
// What replaces it is not a live view but a durable one: a single self-contained HTML file with the
// findings, the conditions they were measured under, and the screenshots inlined as data URLs.
// It travels — attach it to a message, commit it next to the code, open it a week later — which
// the screencast never did.
//
// fs only. No playwright, no daemon: this reads an on-disk verify report, so it works after the
// browser is gone, after the daemon is gone, and from the CLI without a round trip.
import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function dataUrl(file) {
  try {
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** Newest verify-*.json in a session's reports dir, or null. */
export function latestReport(sessionsRoot, name) {
  const dir = path.join(sessionsRoot, name, 'reports');
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^verify-\d+\.json$/.test(f)); } catch { return null; }
  if (!files.length) return null;
  files.sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));
  return path.join(dir, files[files.length - 1]);
}

const SEV_ORDER = { error: 0, warn: 1, info: 2 };

// The three portability classes, spelled out where the reader is looking at the findings rather
// than in documentation they have to have read. A label with no explanation is just a badge.
const PORT_NOTE = {
  portable: 'Computed from values the browser was given — CSS colours, the cascade, the DOM, HTTP status. Means the same thing on any machine.',
  'font-dependent': 'Measured off rendered text width. This run used a substitute typeface, so the number is about THIS render, not the developer\'s.',
  'sandbox-artifact': 'A fact about the environment, not about the code. Would not occur on a normal machine.',
};

export function buildReportHtml(report, { title = 'Glassbox verify', shotsLimit = 8 } = {}) {
  const c = report.conditions || {};
  const findings = [...(report.findings || [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3));
  const shots = (report.artifacts?.screenshots || []).slice(0, shotsLimit);

  const condRow = (k, v, warn) =>
    `<div class="c${warn ? ' warn' : ''}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;

  // Which conditions deserve a highlight: the ones that change what a finding means.
  const conds = [
    condRow('platform', c.platform || 'unknown', c.platform === 'sandbox'),
    condRow('display', c.display || 'unknown', c.display === 'headless'),
    condRow('load', c.load || 'unknown', c.load === 'warm'),
    condRow('egress', c.egress || 'unknown', c.egress === 'jailed'),
    condRow('fonts', c.fonts || 'unknown', c.fonts === 'substituted'),
    condRow('raster', c.raster || 'unknown', c.raster === 'software'),
    condRow('viewport', c.viewport ? `${c.viewport.width}×${c.viewport.height}` : '—', false),
    condRow('colour scheme', c.colorScheme || '—', false),
    condRow('timezone', c.timezone || '—', false),
    c.stubs ? condRow('HAR', `${path.basename(c.stubs.har)} — ${c.stubs.entries} entries, ${c.stubs.fonts} fonts`, false) : '',
  ].join('');

  const counts = Object.entries(report.counts || {})
    .map(([k, v]) => `<span class="n${v ? ' hot' : ''}"><b>${v}</b> ${esc(k)}</span>`)
    .join('');

  const rows = findings.map((f) => `
    <li class="f ${esc(f.severity)}">
      <div class="hd"><span class="sev">${esc(f.severity)}</span><span class="ch">${esc(f.channel)}</span>${
        f.portability && f.portability !== 'portable' ? `<span class="port ${esc(f.portability)}" title="${esc(PORT_NOTE[f.portability] || '')}">${esc(f.portability)}</span>` : ''
      }</div>
      <div class="sum">${esc(f.summary)}</div>
      ${f.detail ? `<div class="det">${esc(Array.isArray(f.detail) ? f.detail.join('\n') : f.detail)}</div>` : ''}
    </li>`).join('');

  const shotHtml = shots.map((s) => {
    const p = typeof s === 'string' ? s : s.path;
    const url = p ? dataUrl(p) : null;
    if (!url) return '';
    return `<figure><img src="${url}" alt="${esc(path.basename(p))}"><figcaption>${esc(path.basename(p))}</figcaption></figure>`;
  }).join('');

  const legend = Object.entries(PORT_NOTE).map(([k, v]) => `<div><b>${esc(k)}</b> — ${esc(v)}</div>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fbfaf9;--fg:#1c1917;--mut:#78716c;--line:#e7e5e4;--err:#b91c1c;--warn:#b45309;--info:#57534e;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--mut:#a8a29e;--line:#292524;--err:#f87171;--warn:#fbbf24;--info:#d6d3d1;--card:#232020}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,"Liberation Sans",sans-serif}
main{max-width:940px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
.url{color:var(--mut);font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;margin-bottom:20px}
.verdict{display:inline-block;padding:3px 10px;border-radius:999px;font-weight:600;font-size:13px}
.verdict.ok{background:#dcfce7;color:#166534}.verdict.bad{background:#fee2e2;color:#991b1b}
@media(prefers-color-scheme:dark){.verdict.ok{background:#14532d;color:#bbf7d0}.verdict.bad{background:#7f1d1d;color:#fecaca}}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--mut);margin:32px 0 10px;font-weight:600}
.conds{margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.c{background:var(--card);padding:9px 12px}
.c.warn{background:#fffbeb}@media(prefers-color-scheme:dark){.c.warn{background:#2a2416}}
.c dt{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:0}
.c dd{margin:2px 0 0;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.counts{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
.n{font-size:12px;padding:3px 8px;border-radius:6px;background:var(--card);border:1px solid var(--line);color:var(--mut)}
.n.hot{color:var(--fg);border-color:var(--mut)}
ul.fs{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
.f{background:var(--card);border:1px solid var(--line);border-left-width:3px;border-radius:7px;padding:10px 13px}
.f.error{border-left-color:var(--err)}.f.warn{border-left-color:var(--warn)}.f.info{border-left-color:var(--info)}
.hd{display:flex;gap:7px;align-items:center;margin-bottom:4px}
.sev{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.f.error .sev{color:var(--err)}.f.warn .sev{color:var(--warn)}.f.info .sev{color:var(--info)}
.ch{font-size:11px;color:var(--mut);border:1px solid var(--line);border-radius:4px;padding:0 5px}
.port{font-size:11px;border-radius:4px;padding:0 5px;cursor:help}
.port.font-dependent{background:#fef3c7;color:#92400e}
.port.sandbox-artifact{background:#e0e7ff;color:#3730a3}
@media(prefers-color-scheme:dark){.port.font-dependent{background:#422006;color:#fcd34d}.port.sandbox-artifact{background:#1e1b4b;color:#c7d2fe}}
.sum{font-size:14px}
.det{margin-top:5px;font-size:12.5px;color:var(--mut);white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
figure{margin:0 0 16px}
figure img{width:100%;border:1px solid var(--line);border-radius:7px;display:block}
figcaption{font-size:11px;color:var(--mut);margin-top:4px;font-family:ui-monospace,monospace}
.legend{font-size:12.5px;color:var(--mut);display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--line);padding-top:14px;margin-top:36px}
.legend b{color:var(--fg);font-family:ui-monospace,monospace;font-weight:600}
</style></head><body><main>
<h1>${esc(title)} <span class="verdict ${report.ok ? 'ok' : 'bad'}">${report.ok ? 'ok' : 'not ok'}</span></h1>
<div class="url">${esc(report.url || '')}</div>

<h2>Conditions this was measured under</h2>
<dl class="conds">${conds}</dl>
<div class="counts">${counts}</div>

<h2>Findings (${findings.length})</h2>
${findings.length ? `<ul class="fs">${rows}</ul>` : '<p style="color:var(--mut)">No findings.</p>'}

${shotHtml ? `<h2>Screenshots</h2>${shotHtml}` : ''}

<div class="legend">${legend}</div>
</main></body></html>`;
}

/** Read a report JSON and write the HTML beside it (or at `out`). Returns the output path. */
export function exportReport(reportPath, { out = null, title } = {}) {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const dest = out || reportPath.replace(/\.json$/, '.html');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buildReportHtml(report, { title: title || `Glassbox verify — ${report.url || ''}` }), 'utf8');
  return { path: dest, ok: report.ok, findings: (report.findings || []).length, bytes: fs.statSync(dest).size };
}
