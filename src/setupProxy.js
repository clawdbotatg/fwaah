const { createProxyMiddleware } = require('http-proxy-middleware');

// Proxy JSON-RPC calls to the local eth node so the browser never deals with CORS.
// Set NODE_RPC_URL in .env (see .env.example) or inline: NODE_RPC_URL=http://host:8545 npm start
module.exports = function (app) {
  app.use(
    '/rpc',
    createProxyMiddleware({
      target: process.env.NODE_RPC_URL || 'http://127.0.0.1:8545',
      changeOrigin: true,
      pathRewrite: { '^/rpc': '' },
    })
  );
};
