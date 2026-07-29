const { createProxyMiddleware } = require('http-proxy-middleware');

// Proxy JSON-RPC calls to the local eth node so the browser never deals with CORS.
// Set NODE_RPC_URL in .env (see .env.example) or inline: NODE_RPC_URL=http://host:8545 npm start
module.exports = function (app) {
  const target = process.env.NODE_RPC_URL || 'http://127.0.0.1:8545';
  // Dev twin of api/meta.js: some collections' metadata hosts send no CORS
  // headers, so the client falls back to /api/meta and we fetch server-side.
  app.use('/api/meta', async (req, res) => {
    let url;
    try {
      url = new URL(String(req.query.u || ''));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('bad scheme');
    } catch (e) {
      res.status(400).json({ error: 'bad url' });
      return;
    }
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      const upstream = await fetch(url, { redirect: 'follow', signal: ctl.signal });
      clearTimeout(timer);
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
      res.status(upstream.status).send(buf);
    } catch (e) {
      res.status(502).json({ error: 'upstream fetch failed' });
    }
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
