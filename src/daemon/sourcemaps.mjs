// Source-map remapping for browser-side stack traces (arch §5, research 05 §10). A minified
// `pageerror` stack (`bundle-Xy9.js:1:48213`) is useless to the fixing agent; we resolve each
// frame back to `{file, line, col}` in the ORIGINAL source. The errors originate in Chromium, not
// in this Node process, so we can't lean on Node's own sourcemap support — we fetch the `.map`
// ourselves (via the PAGE's fetch first, so relative URLs and dev-server routing resolve) and walk
// the mappings. A minimal, dependency-free source-map v3 decoder (mappings only — we never need
// the names table). Per-session cache keyed by bundle URL: a stack with 10 frames from one bundle
// fetches the map once.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = (() => { const m = {}; for (let i = 0; i < B64.length; i++) m[B64[i]] = i; return m; })();

/** Decode one base64-VLQ segment string into its signed integer fields. */
function decodeVLQ(seg) {
  const out = [];
  let shift = 0, value = 0;
  for (const ch of seg) {
    const digit = B64I[ch];
    if (digit === undefined) continue;
    value += (digit & 31) << shift;
    if (digit & 32) { shift += 5; continue; }
    const neg = value & 1;
    value >>= 1;
    out.push(neg ? -value : value);
    value = 0; shift = 0;
  }
  return out;
}

/**
 * Parse a source-map v3 `mappings` string into per-generated-line segment arrays. Per the spec the
 * source/origLine/origCol deltas are cumulative across the WHOLE string; only genCol resets per line.
 */
function parseMappings(mappings) {
  const lines = [];
  let srcIdx = 0, oLine = 0, oCol = 0;
  for (const group of mappings.split(';')) {
    const segs = [];
    let genCol = 0;
    if (group) {
      for (const segStr of group.split(',')) {
        if (!segStr) continue;
        const f = decodeVLQ(segStr);
        genCol += f[0] || 0;
        const seg = { genCol };
        if (f.length >= 4) {
          srcIdx += f[1]; oLine += f[2]; oCol += f[3];
          seg.srcIdx = srcIdx; seg.oLine = oLine; seg.oCol = oCol;
        }
        segs.push(seg);
      }
    }
    lines.push(segs);
  }
  return lines;
}

/** Resolve a 0-based generated (line,col) to original {file,line,col} (1-based) or null. */
function mapPosition(parsed, line0, col0) {
  const { lines, sources, sourceRoot } = parsed;
  const segs = lines[line0];
  if (!segs || !segs.length) return null;
  let best = null;
  for (const s of segs) {
    if (s.oLine === undefined) continue;
    if (s.genCol <= col0) best = s;
    else break;
  }
  if (!best) best = segs.find((s) => s.oLine !== undefined);
  if (!best) return null;
  let file = sources[best.srcIdx] ?? '?';
  if (sourceRoot && !/^(?:\w+:|\/)/.test(file)) file = sourceRoot.replace(/\/$/, '') + '/' + file;
  return { file, line: best.oLine + 1, col: best.oCol + 1 };
}

const FRAME_RE = /((?:https?:\/\/|file:\/\/)[^\s()]+?):(\d+):(\d+)/g;

/**
 * Create a per-session remapper. `session.page` supplies the in-page fetch (relative/`.map` URLs
 * resolve the way the browser sees them); Node's global fetch is the fallback for absolute URLs.
 */
export function createSourceMapper(session) {
  const cache = new Map(); // bundleUrl -> parsed map | null (null = definitively no map)

  async function fetchText(url) {
    try {
      const t = await session.page.evaluate(
        (u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : null)).catch(() => null),
        url,
      );
      if (t != null) return t;
    } catch { /* page torn down / cross-origin — fall through to daemon-side */ }
    try {
      const r = await fetch(url);
      return r.ok ? await r.text() : null;
    } catch { return null; }
  }

  function parseMapJson(json, baseUrl) {
    try {
      const m = typeof json === 'string' ? JSON.parse(json) : json;
      if (!m || !m.mappings || !Array.isArray(m.sources)) return null;
      return { lines: parseMappings(m.mappings), sources: m.sources, sourceRoot: m.sourceRoot || '' , _base: baseUrl };
    } catch { return null; }
  }

  async function mapForBundle(bundleUrl) {
    if (cache.has(bundleUrl)) return cache.get(bundleUrl);
    cache.set(bundleUrl, null); // guard against re-entrancy on the same URL while fetching
    let parsed = null;
    const code = await fetchText(bundleUrl);
    if (code) {
      const m = /\/\/[#@]\s*sourceMappingURL=(\S+)/g;
      let last = null, hit;
      while ((hit = m.exec(code))) last = hit[1];
      if (last) {
        if (last.startsWith('data:')) {
          const comma = last.indexOf(',');
          const meta = last.slice(5, comma);
          const data = last.slice(comma + 1);
          const raw = /base64/i.test(meta) ? Buffer.from(data, 'base64').toString('utf8') : decodeURIComponent(data);
          parsed = parseMapJson(raw, bundleUrl);
        } else {
          const mapUrl = new URL(last, bundleUrl).toString();
          const mapText = await fetchText(mapUrl);
          if (mapText) parsed = parseMapJson(mapText, bundleUrl);
        }
      }
    }
    cache.set(bundleUrl, parsed);
    return parsed;
  }

  /** Remap one "url:line:col" location. Returns {file,line,col} or null. */
  async function remapLoc(loc) {
    if (!loc) return null;
    FRAME_RE.lastIndex = 0;
    const m = FRAME_RE.exec(loc);
    if (!m) return null;
    const parsed = await mapForBundle(m[1]);
    if (!parsed) return null;
    return mapPosition(parsed, Number(m[2]) - 1, Number(m[3]) - 1);
  }

  /**
   * Synchronous, page-free remap using ONLY already-cached maps — safe to call while the target is
   * paused at a breakpoint (mapForBundle's page.evaluate fetch would hang the frozen main thread,
   * research 02 §7). Uncached bundles return null (the caller falls back to the raw location).
   */
  function remapLocCached(loc) {
    if (!loc) return null;
    FRAME_RE.lastIndex = 0;
    const m = FRAME_RE.exec(loc);
    if (!m) return null;
    const parsed = cache.get(m[1]); // undefined (never fetched) or null (no map) → skip
    if (!parsed) return null;
    return mapPosition(parsed, Number(m[2]) - 1, Number(m[3]) - 1);
  }

  /**
   * Remap every frame in a stack string. Returns {frames:[{url,line,col,orig?}], top}. `top` is the
   * first frame that resolved (what a caller wants to surface). Non-resolvable frames pass through.
   */
  async function remapStack(stack) {
    const frames = [];
    if (!stack) return { frames, top: null };
    const matches = [...String(stack).matchAll(FRAME_RE)];
    const wanted = new Set(matches.map((mm) => mm[1]));
    const maps = new Map();
    await Promise.all([...wanted].map(async (u) => maps.set(u, await mapForBundle(u))));
    let top = null;
    for (const mm of matches) {
      const parsed = maps.get(mm[1]);
      const orig = parsed ? mapPosition(parsed, Number(mm[2]) - 1, Number(mm[3]) - 1) : null;
      const frame = { url: mm[1], line: Number(mm[2]), col: Number(mm[3]), ...(orig ? { orig } : {}) };
      frames.push(frame);
      if (orig && !top) top = orig;
    }
    return { frames, top };
  }

  /** Attach `orig` (top resolved frame) + remapped `loc` to a copy of a buffer error entry. */
  async function remapEntry(entry) {
    const out = { ...entry };
    if (entry.stack) {
      const { top } = await remapStack(entry.stack);
      if (top) out.orig = top;
    }
    if (!out.orig && entry.loc) {
      const o = await remapLoc(entry.loc);
      if (o) out.orig = o;
    }
    return out;
  }

  return { remapLoc, remapLocCached, remapStack, remapEntry };
}

/** Lazily attach one remapper per session (cache lives as long as the session). */
export function sourceMapper(session) {
  if (!session._srcmapper) session._srcmapper = createSourceMapper(session);
  return session._srcmapper;
}
