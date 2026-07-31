// Vercel serverless JSON-RPC proxy with SHARED edge caching.
//
// GET  /api/rpc?q=<base64url JSON-RPC batch>  -> cached at Vercel's edge with
//      s-maxage per method, so all visitors share one upstream call per window.
// POST /api/rpc                               -> pass-through, never cached
//      (receipt polling and anything non-deterministic).
//
// Set RPC_UPSTREAM in the Vercel project env (e.g. your Alchemy URL) — the key
// stays server-side and never ships in the client bundle.

const { hotlinkBlocked } = require('./_shared');

const ALLOWED = new Set([
  'eth_call', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getLogs',
  'eth_getBalance', 'eth_getTransactionReceipt', 'net_peerCount',
  'eth_syncing', 'eth_chainId', 'eth_gasPrice',
]);

// edge-cache seconds per method; a batch gets the minimum across its calls
const TTL = {
  eth_blockNumber: 6,
  eth_getBlockByNumber: 6,
  eth_gasPrice: 12,
  eth_call: 12,
  eth_getBalance: 12,
  net_peerCount: 30,
  eth_syncing: 30,
  eth_getLogs: 60,
  eth_chainId: 3600,
  eth_getTransactionReceipt: 0,
};

module.exports = async (req, res) => {
  // Other websites don't get to use this as their free mainnet RPC.
  if (hotlinkBlocked(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const upstream = process.env.RPC_UPSTREAM;
  if (!upstream) {
    res.status(500).json({ error: 'RPC_UPSTREAM env var not configured' });
    return;
  }

  let body;
  try {
    if (req.method === 'GET') {
      body = JSON.parse(Buffer.from(String(req.query.q || ''), 'base64url').toString('utf8'));
    } else if (req.method === 'POST') {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } else {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }
  } catch (e) {
    res.status(400).json({ error: 'malformed request' });
    return;
  }

  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > 64) {
    res.status(400).json({ error: 'bad batch size' });
    return;
  }
  for (const c of calls) {
    if (!c || typeof c.method !== 'string' || !ALLOWED.has(c.method)) {
      res.status(400).json({ error: 'rpc method not allowed: ' + (c && c.method) });
      return;
    }
  }

  let upstreamRes, text;
  try {
    upstreamRes = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    text = await upstreamRes.text();
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'upstream rpc unreachable' });
    return;
  }

  let ttl = Math.min(...calls.map((c) => (TTL[c.method] != null ? TTL[c.method] : 0)));
  if (req.method !== 'GET' || !upstreamRes.ok) ttl = 0;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Cache-Control',
    ttl > 0 ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 5}` : 'no-store'
  );
  res.status(upstreamRes.status).send(text);
};
