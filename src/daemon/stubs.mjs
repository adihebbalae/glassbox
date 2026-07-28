// The HAR fidelity bridge — the piece that makes the two Glassboxes one system rather than two
// tools.
//
// The problem it solves: a sandboxed browser cannot reach the internet, so it renders your page
// with no web fonts, no CDN scripts and no API responses. Fonts are the sharp end. Every
// text-metric measurement the layout audit makes — horizontal overflow, occlusion, clipping,
// font-driven CLS — is computed against whatever fallback face the container happened to have.
// The container here has Liberation and DejaVu and no Segoe UI, Inter or Roboto at all, so
// `font-family: system-ui` resolves to something the developer has never seen. Those findings are
// then measurements of a page that exists nowhere.
//
// The fix is not to install fonts (you cannot guess which) or to whitelist hosts (you cannot reach
// them). It is to carry the real responses in with the code:
//
//     on a networked machine:  glassbox session open x --record-har run.har   … --> run.har
//     in the sandbox:          glassbox session open x --har run.har
//
// One artifact fixes three things at once — egress (the requests resolve), fonts (a HAR embeds the
// font payloads, so the real faces load and text metrics become real), and determinism (the same
// bytes every run, so a finding that moves is the code moving).
import fs from 'node:fs';
import { CODES, gbErr } from '../protocol.mjs';

/**
 * @param {import('playwright').BrowserContext} context
 * @param {object} opts
 *   har        path to a HAR to replay
 *   harNotFound 'fallback' (default) — unmatched requests go to the real network, which is what
 *               you want when the dev server is local and only third parties are missing — or
 *               'abort', for a fully hermetic run where any unrecorded request is itself a finding.
 *   harUrl     optional glob; only matching URLs are served from the HAR.
 * @returns {Promise<object|null>} a descriptor for the conditions block, or null if nothing installed
 */
export async function installStubs(context, opts = {}) {
  if (!opts.har) return null;
  const har = String(opts.har);
  if (!fs.existsSync(har)) {
    throw gbErr(CODES.BAD_REQUEST, `har file not found: ${har}`, {
      field: 'har',
      correction_hint: 'record one first on a networked machine: glassbox session open <name> --record-har <path>',
    });
  }
  const notFound = opts.harNotFound === 'abort' ? 'abort' : 'fallback';
  const routeOpts = { notFound, update: false };
  if (opts.harUrl) routeOpts.url = opts.harUrl;
  await context.routeFromHAR(har, routeOpts);

  let entries = 0;
  let fonts = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(har, 'utf8'));
    const list = parsed?.log?.entries || [];
    entries = list.length;
    fonts = list.filter((e) => /font|woff/i.test(e?.response?.content?.mimeType || '') || /\.(woff2?|ttf|otf)(\?|$)/i.test(e?.request?.url || '')).length;
  } catch { /* a HAR we can't parse can still be replayed by playwright; don't fail the session for stats */ }

  return { har, notFound, url: opts.harUrl || '**', entries, fonts };
}

/**
 * Context options for the RECORDING side. Must be passed at newContext time — playwright writes
 * the file on context.close(), so a session recording a HAR has to be closed cleanly (kill -9 on
 * the daemon loses the recording, which is why `session close` is the documented end of a record).
 */
export function recordOptions(opts = {}) {
  if (!opts.recordHar) return null;
  return {
    // 'embed' inlines response bodies — including font binaries, which is the entire point.
    recordHar: { path: String(opts.recordHar), content: 'embed', mode: 'full' },
  };
}

/**
 * Fonts are the reason this bridge exists, so the conditions block says which state a run was in
 * rather than leaving the reader to infer it.
 *
 * `substituted` is asserted on EVIDENCE, never on the mere fact of being in a container. A page
 * that ships no web fonts loses nothing to a jailed network, and telling its author that "web fonts
 * did not load" would be a false warning — which is the same sin as a false all-clear, just
 * pointing the other way. `evidence` is the count of font/stylesheet requests the jail actually
 * ate, plus any FontFace the browser reports as failed.
 */
export function fontState({ jailed, stubs, evidence = 0 }) {
  if (stubs && stubs.fonts > 0) return 'har-replayed';
  if (!jailed) return 'system';
  return evidence > 0 ? 'substituted' : 'local-only';
}

/** Requests the jail ate that a typeface depended on. Stylesheets count: a blocked Google Fonts
 *  CSS file means the @font-face rules never existed, so no font request is ever even attempted. */
export function blockedFontEvidence(blocked = []) {
  return blocked.filter((r) =>
    r.type === 'Font' || r.type === 'Stylesheet' || /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(r.url || '') || /fonts\.(googleapis|gstatic)\.com|use\.typekit|fonts\.bunny\.net/i.test(r.url || '')
  ).length;
}
