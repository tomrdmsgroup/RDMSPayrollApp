// server/src/index.js

const http = require('http');
const { router } = require('./api/routes');
const { env } = require('./config');
const { opsRouter } = require('./routes/opsRoutes');
const { initDb } = require('./domain/db');

function toUrl(req) {
  const host = req.headers && req.headers.host ? req.headers.host : 'localhost';
  return new URL(req.url || '/', `http://${host}`);
}

async function main() {
  await initDb();

  const server = http.createServer((req, res) => {
  const url = toUrl(req);

  // TEMP: DB existence check for excluded_staff
  if (url.pathname === '/_dbcheck/excluded-staff') {
    (async () => {
      try {
        const { query } = require('./domain/db');
        const r = await query("select to_regclass('public.excluded_staff') as table_name");
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, table: r.rows[0].table_name }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    })();
    return;
  }

  if ((url.pathname || '').startsWith('/ops')) {
    return opsRouter(req, res, url);
  }

  return router(req, res);
});


  const port = env.PORT || 3000;
  server.listen(port, '0.0.0.0', () => console.log(`Server listening on ${port}`));
}

main().catch((err) => {
  console.error('fatal_startup_error', err);
  process.exit(1);
});
