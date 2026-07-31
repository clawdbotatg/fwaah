const { createProxyMiddleware } = require('http-proxy-middleware');
const { safeFetch } = require('../api/_shared');

// Proxy JSON-RPC calls to the local eth node so the browser never deals with CORS.
// Set NODE_RPC_URL in .env (see .env.example) or inline: NODE_RPC_URL=http://host:8545 npm start
module.exports = function (app) {
  const target = process.env.NODE_RPC_URL || 'http://127.0.0.1:8545';
  // Dev twin of api/meta.js: some collections' metadata hosts send no CORS
  // headers, so the client falls back to /api/meta and we fetch server-side.
  // safeFetch blocks private/LAN hosts on every redirect hop — this runs on
  // home networks, where an open fetch proxy would reach the router/node.
  app.use('/api/meta', async (req, res) => {
    let upstream;
    try {
      upstream = await safeFetch(req.query.u);
    } catch (e) {
      if (e && e.code) res.status(e.code).json({ error: e.msg });
      else res.status(502).json({ error: 'upstream fetch failed' });
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.status(upstream.status).send(buf);
  });
  // Tell the UI where /rpc actually points, so the status bar can show the
  // node's address. Dev-server only — the hosted site never uses /rpc.
  app.use('/rpc-target', (req, res) => {
    res.json({ host: new URL(target).host });
  });
  app.use(
    '/rpc',
    createProxyMiddleware({
      target,
      changeOrigin: true,
      pathRewrite: { '^/rpc': '' },
    })
  );
};
