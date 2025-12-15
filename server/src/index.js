const http = require('http');
const { router } = require('./api/routes');
const { env } = require('./config');
const { seedAdmin } = require('./domain/authService');

seedAdmin(env.APP_DEFAULT_ADMIN_EMAIL || 'admin@example.com', env.APP_DEFAULT_ADMIN_PASSWORD || 'changeme');

const server = http.createServer((req, res) => router(req, res));
const port = env.PORT || 3000;
server.listen(port, () => console.log(`Server listening on ${port}`));
