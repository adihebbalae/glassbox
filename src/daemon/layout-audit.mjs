// Layout-pathology audit: ONE injected JS payload, ONE Runtime.evaluate round-trip (research 05
// §5 prescribes exactly this — every sub-check is a cheap synchronous Chromium DOM primitive, so
// bundle them instead of paying N round-trips). Returns a structured object; verify.mjs turns it
// into findings. An async IIFE because CLS needs a buffered PerformanceObserver to flush a tick.
//
// Checks: horizontal overflow (page + the outermost elements past the right edge), occlusion
// (interactive element whose center elementFromPoint hits a different, non-ancestor element — the
// occluder is reported), invisible-but-laid-out interactive (Element.checkVisibility, narrowed to
// elements that still occupy a box — display:none is deliberate, see the sweep below),
// zero-size interactive targets, broken images (complete && naturalWidth===0), text contrast
// (effective fg composited over the effective bg walk, WCAG relative-luminance ratio < threshold),
// and CLS (buffered layout-shift entries, hadRecentInput filtered, with moved-node descriptions).
// Each category capped; the overflow count kept in `truncated`.

/** Build the single evaluate payload string. `cfg`: {scope?, cap?, contrastMin?}. */
export function layoutAuditSource(cfg = {}) {
  const CFG = JSON.stringify({ scope: cfg.scope || null, cap: cfg.cap || 10, contrastMin: cfg.contrastMin || 3.0 });
  return `(async () => {
  const CFG = ${CFG};
  const cap = CFG.cap;
  const docEl = document.documentElement;
  const root = CFG.scope ? (document.querySelector(CFG.scope) || document) : document;
  const out = { overflow:[], occlusion:[], invisible:[], zeroSize:[], brokenImages:[], contrast:[], cls:[], truncated:{} };
  const SEL = 'a,button,input,select,textarea,[onclick],[role],[tabindex]';

  const describe = (el) => {
    if (!el || !el.tagName) return '?';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else {
      let c = el.className; if (c && c.baseVal !== undefined) c = c.baseVal;
      if (c && typeof c === 'string' && c.trim()) s += '.' + c.trim().split(/\\s+/).slice(0, 2).join('.');
    }
    const p = el.parentElement;
    if (p) { const same = Array.from(p.children).filter((x) => x.tagName === el.tagName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')'; }
    return s.slice(0, 90);
  };
  const visible = (el) => { try { return el.checkVisibility({ checkOpacity:true, checkVisibilityCSS:true, contentVisibilityAuto:true }); } catch(e) { return true; } };
  const parseColor = (str) => { const m = String(str).match(/rgba?\\(([^)]+)\\)/); if (!m) return [0,0,0,0]; const p = m[1].split(',').map((s)=>parseFloat(s)); return [p[0]||0,p[1]||0,p[2]||0, p[3]===undefined?1:p[3]]; };
  const over = (t,b) => { const a=t[3]; return [t[0]*a+b[0]*(1-a), t[1]*a+b[1]*(1-a), t[2]*a+b[2]*(1-a), 1]; };
  const effBg = (el) => { let bg=[255,255,255,1]; const chain=[]; let n=el; while(n){ chain.push(parseColor(getComputedStyle(n).backgroundColor)); n=n.parentElement; } for(let i=chain.length-1;i>=0;i--){ if(chain[i][3]>0) bg=over(chain[i],bg); } return bg; };
  const lum = (c) => { const s=[c[0],c[1],c[2]].map((v)=>{ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }); return 0.2126*s[0]+0.7152*s[1]+0.0722*s[2]; };
  const ratio = (a,b) => { const L1=lum(a),L2=lum(b),hi=Math.max(L1,L2),lo=Math.min(L1,L2); return (hi+0.05)/(lo+0.05); };
  const cappedPush = (arr, name, item) => { if (arr.length < cap) arr.push(item); else out.truncated[name] = (out.truncated[name]||0) + 1; };

  // --- horizontal overflow ---------------------------------------------------
  const vw = docEl.clientWidth;
  const pageOver = docEl.scrollWidth > vw + 1 || (document.body && document.body.scrollWidth > vw + 1);
  if (pageOver) {
    cappedPush(out.overflow, 'overflow', { type:'overflow', desc:'document', detail:'page scrollWidth ' + docEl.scrollWidth + ' > clientWidth ' + vw });
    for (const el of root.querySelectorAll('*')) {
      const r = el.getBoundingClientRect(); if (r.width <= 0) continue;
      if (r.right > vw + 1 && r.left < vw) {
        const p = el.parentElement; const pr = p ? p.getBoundingClientRect() : null;
        if (!pr || pr.right <= vw + 1) cappedPush(out.overflow, 'overflow', { type:'overflow', desc:describe(el), detail:'extends to ' + Math.round(r.right) + 'px, past the ' + vw + 'px viewport (width ' + Math.round(r.width) + 'px)' });
      }
    }
  }

  // --- interactive sweep: occlusion / invisible / zero-size ------------------
  // \`display:none\` (on the element or an ancestor) is the STANDARD way to hide a responsive
  // alternate, a closed menu, or a dialog — it collapses the box to 0×0, is unfocusable, and is
  // almost always deliberate. Flagging it turns every responsive site into a wall of noise (proven
  // against a real Astro site: 9 of 12 findings were one hidden mobile nav). So the invisible class
  // is narrowed to what is genuinely a bug: an element that STILL OCCUPIES LAYOUT yet cannot be
  // seen (visibility:hidden / opacity:0 / content-visibility) — the invisible-overlay-button and
  // forgot-to-fade-back-in cases. Zero-size is likewise only asserted for elements that ARE visible.
  for (const el of root.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    const occupies = r.width >= 1 && r.height >= 1;
    if (!visible(el)) {
      if (occupies) {
        const cs0 = getComputedStyle(el);
        const why = cs0.visibility !== 'visible' ? 'visibility:' + cs0.visibility
          : (parseFloat(cs0.opacity) === 0 ? 'opacity:0' : 'content-visibility');
        cappedPush(out.invisible, 'invisible', { type:'invisible', desc:describe(el), detail:'takes up ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px of layout but cannot be seen (' + why + ')' });
      }
      continue;
    }
    if (!occupies) { cappedPush(out.zeroSize, 'zeroSize', { type:'zeroSize', desc:describe(el), detail:'interactive target measures ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px' }); continue; }
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;
    let hit; try { hit = document.elementFromPoint(cx, cy); } catch(e) { hit = null; }
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      cappedPush(out.occlusion, 'occlusion', { type:'occlusion', desc:describe(el), detail:'covered at its center by ' + describe(hit) });
    }
  }

  // --- broken images ---------------------------------------------------------
  for (const img of root.querySelectorAll('img')) {
    if (img.complete && img.naturalWidth === 0) cappedPush(out.brokenImages, 'brokenImages', { type:'brokenImage', desc:describe(img), detail:'failed to load: ' + (img.currentSrc || img.src || '(no src)').slice(0,200) });
  }

  // --- text contrast ---------------------------------------------------------
  const hasOwnText = (el) => { for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true; return false; };
  let scanned = 0;
  for (const el of root.querySelectorAll('*')) {
    if (++scanned > 4000) break;
    if (!hasOwnText(el) || !visible(el)) continue;
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    let fg = parseColor(cs.color); if (fg[3] === 0) continue;
    const bg = effBg(el);
    if (fg[3] < 1) fg = over(fg, bg);
    const cr = ratio(fg, bg);
    if (cr < CFG.contrastMin) cappedPush(out.contrast, 'contrast', { type:'contrast', desc:describe(el), detail:'contrast ratio ' + cr.toFixed(2) + ':1 (text ' + cs.color + ' on ~rgb(' + bg.slice(0,3).map(Math.round).join(',') + '))' });
  }

  // --- cumulative layout shift (buffered) ------------------------------------
  const shifts = await new Promise((res) => {
    const es = []; let po;
    try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) es.push(e); }); po.observe({ type:'layout-shift', buffered:true }); }
    catch(e) { return res([]); }
    setTimeout(() => { try { po.disconnect(); } catch(e){} res(es); }, 80);
  });
  for (const e of shifts) {
    if (e.value < 0.005) continue;
    const nodes = []; for (const s of (e.sources||[])) if (s.node && s.node.nodeType === 1) nodes.push(describe(s.node));
    cappedPush(out.cls, 'cls', { type:'cls', desc: nodes[0] || 'page', detail:'layout shift value ' + e.value.toFixed(4) + (nodes.length ? '; moved: ' + nodes.slice(0,3).join(', ') : '') });
  }

  return out;
})()`;
}
