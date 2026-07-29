const { createProxyMiddleware } = require('http-proxy-middleware');

// Proxy JSON-RPC calls to the local eth node so the browser never deals with CORS.
// Set NODE_RPC_URL in .env (see .env.example) or inline: NODE_RPC_URL=http://host:8545 npm start
module.exports = function (app) {
  const target = process.env.NODE_RPC_URL || 'http://127.0.0.1:8545';
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
