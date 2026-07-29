// NFT metadata/image proxy with shared edge caching.
//
// GET /api/meta?u=<encodeURIComponent(url)> — fetches the URL server-side and
// replays it with Access-Control-Allow-Origin: *, because several big
// collections' metadata hosts (token.artblocks.io, miladymaker.net,
// metadata.veefriends.com, metadata.opepen.art, …) send no CORS headers, which
// kills the browser's direct fetch. Token metadata is effectively immutable,
// so responses edge-cache for a day and all visitors share one upstream hit.

const MAX_BYTES = 5 * 1024 * 1024;

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

module.exports = async (req, res) => {
  let url;
  try {
    url = new URL(String(req.query.u || ''));
  } catch (e) {
    res.status(400).json({ error: 'bad url' });
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    res.status(400).json({ error: 'bad scheme' });
    return;
  }
  if (blockedHost(url.hostname)) {
    res.status(400).json({ error: 'blocked host' });
    return;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let upstream;
  try {
    upstream = await fetch(url, { redirect: 'follow', signal: ctl.signal });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'upstream fetch failed' });
    return;
  } finally {
    clearTimeout(timer);
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(413).json({ error: 'too large' });
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.setHeader(
    'Cache-Control',
    upstream.ok ? 'public, s-maxage=86400, stale-while-revalidate=604800' : 'no-store'
  );
  res.status(upstream.status).send(buf);
};
