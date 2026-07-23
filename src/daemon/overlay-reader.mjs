// Generic build-error overlay reader (arch §5, research 07 §2). Vite, Astro (Vite under the hood),
// and Next all park their dev-error UI in an OPEN-mode Shadow DOM with stable internal class names,
// which `Runtime.evaluate` reads straight through. One injected payload, one round-trip: probe the
// two known custom elements by name, then fall back to scanning top-level custom elements whose tag
// looks like an error overlay. Returns {framework, message, file, frame} or null — a build error
// becomes a structured finding (channel 'overlay', severity 'error'), never a screenshot of a red box.

// Self-contained IIFE string (no closures over daemon state): safe to pass to page.evaluate.
const SRC = `(() => {
  const txt = (root, sels) => {
    for (const s of sels) { const e = root.querySelector(s); if (e && e.textContent.trim()) return e.textContent.trim(); }
    return '';
  };
  const read = (host, framework) => {
    const sr = host.shadowRoot; if (!sr) return null;
    const message = txt(sr, ['.message-body', '.message', '[data-nextjs-dialog-header]', '.nextjs__container_errors_desc', 'h1']);
    if (!message) return null;
    return {
      framework,
      message: message.slice(0, 800),
      file: txt(sr, ['.file', '[data-nextjs-codeframe] .file-name', '.file-link']).slice(0, 400),
      frame: txt(sr, ['.frame', '.code-frame', '[data-nextjs-codeframe]']).slice(0, 1200),
    };
  };
  const vite = document.querySelector('vite-error-overlay');
  if (vite) { const r = read(vite, 'vite'); if (r) return r; }
  const next = document.querySelector('nextjs-portal');
  if (next) { const r = read(next, 'nextjs'); if (r) return r; }
  // Generic fallback: any top-level custom element whose tag reads like an overlay/portal.
  const roots = [];
  const push = (n) => { if (n && n.children) for (const c of n.children) roots.push(c); };
  push(document.body); push(document.documentElement);
  for (const el of roots) {
    const tag = (el.tagName || '').toLowerCase();
    if (el.shadowRoot && (/-(?:error-)?overlay$/.test(tag) || /-portal$/.test(tag))) {
      const r = read(el, tag); if (r) return r;
    }
  }
  return null;
})()`;

/** Read the current build-error overlay, if any. Returns the structured object or null. */
export async function readOverlay(session) {
  try {
    return await session.page.evaluate(SRC);
  } catch {
    return null; // page torn down / navigating — no overlay to report
  }
}

export const OVERLAY_SRC = SRC;
