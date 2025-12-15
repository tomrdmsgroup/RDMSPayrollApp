const { authenticate, seedAdmin } = require('../domain/authService');
const { issueToken, validateToken } = require('../domain/tokenService');
const { createRunRecord, appendEvent, failRun } = require('../domain/runManager');
const { generateRunWip, generateWfnWip } = require('../domain/exportService');
const { IdempotencyService } = require('../domain/idempotencyService');

const idempotency = new IdempotencyService();

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}

function router(req, res) {
  if (req.url === '/health') return json(res, 200, { ok: true });
  if (req.url === '/auth/seed' && req.method === 'POST') {
    parseBody(req).then((body) => {
      seedAdmin(body.email, body.password);
      json(res, 200, { status: 'seeded' });
    });
    return;
  }
  if (req.url === '/auth/login' && req.method === 'POST') {
    parseBody(req).then((body) => {
      const user = authenticate(body.email, body.password);
      if (!user) return json(res, 401, { error: 'invalid_credentials' });
      json(res, 200, { user });
    });
    return;
  }
  if (req.url === '/tokens/issue' && req.method === 'POST') {
    parseBody(req).then((body) => {
      try {
        const token = issueToken({ action: body.action, runId: body.runId, periodStart: body.periodStart, periodEnd: body.periodEnd, recipientEmail: body.recipientEmail, ttlMinutes: body.ttlMinutes || 60 });
        json(res, 200, { token });
      } catch (e) {
        json(res, 400, { error: e.message });
      }
    });
    return;
  }
  if (req.url === '/runs/manual' && req.method === 'POST') {
    parseBody(req).then((body) => {
      const run = createRunRecord({ clientLocationId: body.clientLocationId, periodStart: body.periodStart, periodEnd: body.periodEnd });
      appendEvent(run, 'manual_start');
      try {
        const toastMetadata = { count: 0 };
        appendEvent(run, 'toast_fetch', toastMetadata);
        const exportLines = generateRunWip([]);
        appendEvent(run, 'export_generated', { length: exportLines.length });
        run.status = 'completed';
        json(res, 200, { run });
      } catch (e) {
        failRun(run, 'manual_run', e.message);
        json(res, 500, { error: e.message, run });
      }
    });
    return;
  }
  if (req.url === '/idempotency/check' && req.method === 'POST') {
    parseBody(req).then((body) => {
      const exists = idempotency.check(body.scope, body.key);
      if (exists) return json(res, 200, { reused: true });
      idempotency.record(body.scope, body.key);
      json(res, 200, { reused: false });
    });
    return;
  }

  json(res, 404, { error: 'not_found' });
}

module.exports = { router };
