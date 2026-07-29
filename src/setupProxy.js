const { createProxyMiddleware } = require('http-proxy-middleware');

// Proxy JSON-RPC calls to the local eth node so the browser never deals with CORS.
// Override the node URL with NODE_RPC_URL when starting: NODE_RPC_URL=http://host:8545 npm start
module.exports = function (app) {
  app.use(
    '/rpc',
    createProxyMiddleware({
      target: process.env.NODE_RPC_URL || 'http://192.168.68.54:8545',
      changeOrigin: true,
      pathRewrite: { '^/rpc': '' },
    })
  );
};
