// NFT metadata/image proxy with shared edge caching.
//
// GET /api/meta?u=<encodeURIComponent(url)> — fetches the URL server-side and
// replays it with Access-Control-Allow-Origin: *, because several big
// collections' metadata hosts (token.artblocks.io, miladymaker.net,
// metadata.veefriends.com, metadata.opepen.art, …) send no CORS headers, which
// kills the browser's direct fetch. Token metadata is effectively immutable,
// so responses edge-cache for a day and all visitors share one upstream hit.
//
// Guards (api/_shared.js): hotlink block, private-host block re-checked on
// every redirect hop, 15s timeout, 5MB cap.

const { hotlinkBlocked, safeFetch } = require('./_shared');

const MAX_BYTES = 5 * 1024 * 1024;

module.exports = async (req, res) => {
  if (hotlinkBlocked(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  let upstream;
  try {
    upstream = await safeFetch(req.query.u);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    if (e && e.code) res.status(e.code).json({ error: e.msg });
    else res.status(502).json({ error: 'upstream fetch failed' });
    return;
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
