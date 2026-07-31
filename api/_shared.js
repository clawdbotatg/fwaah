// Shared guards for the api/ functions (and the dev twin in setupProxy.js).
// The underscore prefix keeps Vercel from exposing this file as an endpoint.

// Private/internal hosts the proxies must never fetch — blocks SSRF at the
// initial URL AND at every redirect hop (see safeFetch).
function blockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return true;
  }
  if (h.includes(':')) return true; // IPv6 literals — not worth allowlisting
  return false;
}

// Referer/Origin hostnames allowed to use the proxies — our own pages only.
function allowedReferrer(ref) {
  try {
    const h = new URL(ref).hostname.toLowerCase();
    return h === 'fwaah.com' || h.endsWith('.fwaah.com')
      || h.endsWith('.vercel.app') // preview deploys
      || h === 'localhost' || h === '127.0.0.1';
  } catch (e) {
    return false;
  }
}

// Block other websites from riding through a proxy (bandwidth/quota burn).
// Browsers on our pages send same-origin markers; a foreign page's fetch
// arrives with a cross-site marker or a foreign Referer. Bare clients with
// no headers pass — the edge cache and per-function checks bound that damage.
function hotlinkBlocked(req) {
  const ref = req.headers.referer || req.headers.origin;
  return req.headers['sec-fetch-site'] === 'cross-site' || (ref && !allowedReferrer(ref));
}

// fetch() that re-applies the scheme + private-host checks on every redirect
// hop, so a public URL can't 302 its way to a LAN address or cloud metadata.
// Throws { code, msg } for a guard failure; network errors propagate as-is.
async function safeFetch(rawUrl, { timeoutMs = 15000, maxHops = 5 } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch (e) {
    throw { code: 400, msg: 'bad url' };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= maxHops; hop++) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw { code: 400, msg: 'bad scheme' };
      if (blockedHost(url.hostname)) throw { code: 400, msg: 'blocked host' };
      const res = await fetch(url, { redirect: 'manual', signal: ctl.signal });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url);
        continue;
      }
      return res;
    }
    throw { code: 502, msg: 'too many redirects' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { blockedHost, allowedReferrer, hotlinkBlocked, safeFetch };
