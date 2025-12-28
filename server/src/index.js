// server/src/index.js

const http = require('http');
const { router } = require('./api/routes');
const { env } = require('./config');
const { seedAdmin } = require('./domain/authService');
const { opsRouter } = require('./routes/opsRoutes');

seedAdmin(
  env.APP_DEFAULT_ADMIN_EMAIL || 'admin@example.com',
  env.APP_DEFAULT_ADMIN_PASSWORD || 'changeme',
);

function toUrl(req) {
  const host = req.headers && req.headers.host ? req.headers.host : 'localhost';
  return new URL(req.url || '/', `http://${host}`);
}

const server = http.createServer((req, res) => {
  const url = toUrl(req);

  if ((url.pathname || '').startsWith('/ops')) {
    return opsRouter(req, res, url);
  }

  return router(req, res);
});

const port = env.PORT || 3000;
server.listen(port, () => console.log(`Server listening on ${port}`));
