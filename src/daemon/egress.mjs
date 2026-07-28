// Egress classification — the fifth network bucket.
//
// An agent sandbox routes all outbound traffic through an allowlisting proxy: package registries
// are permitted, everything else is refused. Measured on one such image: `example.com`,
// `cdn.jsdelivr.net` and `fonts.googleapis.com` all return 403 to Node and curl, and surface
// inside Chromium as `net::ERR_TUNNEL_CONNECTION_FAILED`.
//
// For a UI verifier this is not a nuisance, it is a correctness problem. The four existing buckets
// (failed | httpError | hanging | mixedContent) exist to name real defects. Run a normal app in
// that jail and every web font, every CDN script and every API call lands in `failed`, so verify
// reports a wall of red that says nothing about the code — and, worse, real failures become
// invisible inside the noise. The instrument would be lying in both directions at once.
//
// So a jailed platform gets a fifth bucket. A request is `sandboxBlocked` when it went to an
// origin the sandbox cannot reach and failed the way the proxy fails things. It is NEVER counted
// toward `ok`, because it is not a fact about the code under test — it would have succeeded on the
// developer's machine.
//
// The rule is deliberately conservative in the one direction that matters: same-origin and
// loopback requests are ALWAYS the app's, whatever they look like, so a broken local API can never
// be excused as "the sandbox did it".

/** Proxy-refusal signatures. A CONNECT that the proxy declines surfaces as one of these. */
const PROXY_ERRORS = /ERR_(TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|MANDATORY_PROXY_CONFIGURATION_FAILED|NAME_NOT_RESOLVED|CERT_AUTHORITY_INVALID|BLOCKED_BY_CLIENT|CONNECTION_TIMED_OUT|CONNECTION_RESET|CONNECTION_REFUSED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED)/i;

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\]|::1|0\.0\.0\.0|host\.docker\.internal)$/i;

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export function originOf(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return ''; }
}

/** Loopback and private ranges are the app under test, by definition — never the far side of a proxy. */
export function isLocalHost(host) {
  if (!host) return false;
  if (LOOPBACK.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * Decide whether a failed request belongs to the app or to the jail.
 *
 * @param {object} r        the request record ({url, status, errorText, failed})
 * @param {object} ctx      {policy:'open'|'jailed', origins:string[]}  origins = the app's own
 *                          origins (page origin + baseURL), which are never demoted.
 * @returns {'app'|'sandbox'}
 */
export function classifyEgress(r, ctx) {
  if (!ctx || ctx.policy !== 'jailed') return 'app';
  const host = hostOf(r.url);
  if (!host) return 'app';
  if (isLocalHost(host)) return 'app';
  const origin = originOf(r.url);
  if (ctx.origins && ctx.origins.includes(origin)) return 'app';

  // A transport failure to an unreachable external origin under a jailed policy is the jail.
  if (r.failed && PROXY_ERRORS.test(String(r.errorText || ''))) return 'sandbox';
  // Some proxies answer the CONNECT and then refuse at the HTTP layer.
  if (typeof r.status === 'number' && (r.status === 403 || r.status === 407)) return 'sandbox';
  // Anything else — a real 404 from a reachable CDN, a 500 from a real API — is the app's problem.
  return 'app';
}

/**
 * Split an already-classified taxonomy, moving jail casualties out of `failed`/`httpError` into a
 * fifth bucket. Returns the mutated taxonomy plus the extracted rows, so the on-disk report can
 * keep every row (demoted, never deleted — the same contract `ignore404` already honours).
 */
export function splitEgress(net, ctx) {
  if (!ctx || ctx.policy !== 'jailed') return { net, sandboxBlocked: [] };
  const blocked = [];
  const keepFailed = [];
  for (const r of net.failed) {
    if (classifyEgress({ ...r, failed: true }, ctx) === 'sandbox') blocked.push({ ...r, blockedBy: 'sandbox-egress' });
    else keepFailed.push(r);
  }
  const keepHttp = [];
  for (const r of net.httpError) {
    if (classifyEgress(r, ctx) === 'sandbox') blocked.push({ ...r, blockedBy: 'sandbox-egress' });
    else keepHttp.push(r);
  }
  net.failed = keepFailed;
  net.httpError = keepHttp;
  return { net, sandboxBlocked: blocked };
}

/**
 * One info line, not a flood — the same noise discipline verify already applies to an open modal's
 * backdrop and to allowlisted 404s. Names the distinct hosts so the reader can tell at a glance
 * whether the blocked thing was a font CDN (cosmetic here, fine in production) or their own API
 * (this run measured an app with no data in it, and every finding should be read that way).
 */
export function egressFinding(blocked) {
  if (!blocked.length) return null;
  const hosts = [...new Set(blocked.map((r) => hostOf(r.url)).filter(Boolean))];
  const shown = hosts.slice(0, 6).join(', ');
  const more = hosts.length > 6 ? ` +${hosts.length - 6} more` : '';
  return {
    channel: 'network',
    severity: 'info',
    portability: 'sandbox-artifact',
    summary: `${blocked.length} external request${blocked.length === 1 ? '' : 's'} blocked by sandbox egress, not by your code: ${shown}${more}`,
    detail: [
      'These would resolve on a normal network. They are excluded from ok/counts.',
      'If any of these is your own API or a font your layout depends on, this run measured a page that does not exist anywhere else — record a HAR on a networked machine and replay it with --har.',
    ],
  };
}
