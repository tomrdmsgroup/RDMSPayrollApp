// server/src/api/routes.js

const { authenticate, seedAdmin } = require('../domain/authService');
const { issueToken } = require('../domain/tokenService');
const { createRunRecord, appendEvent, failRun, getRun } = require('../domain/runManager');
const { approveAction, rerunAction } = require('../domain/approvalService');
const { IdempotencyService } = require('../domain/idempotencyService');
const { notifyFailure } = require('../domain/failureService');
const { runValidation } = require('../domain/validationEngine');

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
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') return json(res, 200, { ok: true });

  if (url.pathname === '/auth/seed' && req.method === 'POST') {
    parseBody(req).then((body) => {
      seedAdmin(body.email, body.password);
      json(res, 200, { status: 'seeded' });
    });
    return;
  }

  if (url.pathname === '/auth/login' && req.method === 'POST') {
    parseBody(req).then((body) => {
      const user = authenticate(body.email, body.password);
      if (!user) return json(res, 401, { error: 'invalid_credentials' });
      json(res, 200, { user });
    });
    return;
  }

  if (url.pathname === '/tokens/issue' && req.method === 'POST') {
    parseBody(req).then((body) => {
      try {
        const token = issueToken({
          action: body.action,
          runId: body.runId,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          ttlMinutes: body.ttlMinutes || 60,
        });
        json(res, 200, { token });
      } catch (e) {
        json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // Manual run: creates a run record and executes validation.
  // IMPORTANT: always pass exclusions (even empty) to freeze the contract.
  if (url.pathname === '/runs/manual' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      const run = createRunRecord({
        clientLocationId: body.clientLocationId,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
      });

      appendEvent(run, 'manual_start');

      try {
        const toastMetadata = { count: 0 };
        appendEvent(run, 'toast_fetch', toastMetadata);

        const exclusions = [];

        const validation = await runValidation({
          run,
          context: {
            clientLocationId: body.clientLocationId,
            periodStart: body.periodStart,
            periodEnd: body.periodEnd,
          },
          exclusions,
        });

        appendEvent(run, 'validation_completed', { findings_count: validation.findings.length });

        const exportLines = require('../domain/exportService').generateRunWip([]);
        appendEvent(run, 'export_generated', { length: exportLines.length });

        const approveToken = issueToken({
          action: 'approve',
          runId: run.id,
          periodStart: run.period_start,
          periodEnd: run.period_end,
        });

        const rerunToken = issueToken({
          action: 'rerun',
          runId: run.id,
          periodStart: run.period_start,
          periodEnd: run.period_end,
        });

        appendEvent(run, 'tokens_issued', { approve: approveToken.token_id, rerun: rerunToken.token_id });

        run.status = 'completed';

        json(res, 200, {
          run,
          tokens: { approve: approveToken.token_id, rerun: rerunToken.token_id },
        });
      } catch (e) {
        failRun(run, 'manual_run', e.message);
        json(res, 500, { error: e.message, run });
      }
    });
    return;
  }

  // Validate an existing run: executes validation against the stored run record.
  // IMPORTANT: always pass exclusions (even empty) to freeze the contract.
  // NOTE: no demo behavior (binder prohibits demo rules).
  if (url.pathname === '/runs/validate' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      const run = getRun(body.runId);
      if (!run) return json(res, 404, { error: 'run_not_found' });

      try {
        const exclusions = [];

        const validation = await runValidation({
          run,
          context: {
            clientLocationId: run.client_location_id,
            periodStart: run.period_start,
            periodEnd: run.period_end,
          },
          exclusions,
        });

        appendEvent(run, 'validation_completed', { findings_count: validation.findings.length });

        return json(res, 200, {
          run_id: run.id,
          findings: validation.findings,
          exclusion_decisions: validation.exclusion_decisions || null,
        });
      } catch (e) {
        failRun(run, 'validate_run', e.message);
        return json(res, 500, { error: e.message, run_id: run.id });
      }
    });
    return;
  }

  if (url.pathname === '/idempotency/check' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      const exists = idempotency.check(body.scope, body.key);
      if (exists) return json(res, 200, { reused: true });
      idempotency.record(body.scope, body.key);
      json(res, 200, { reused: false });
    });
    return;
  }

  if (url.pathname === '/approve' && req.method === 'GET') {
    const tokenId = url.searchParams.get('token');
    if (!tokenId) {
      notifyFailure({ step: 'approve', error: 'missing_token', runId: null });
      return json(res, 400, { error: 'missing_token' });
    }
    const result = approveAction(tokenId);
    const statusCode = result.status === 'invalid' || result.status === 'missing_run' ? 400 : 200;
    return json(res, statusCode, result);
  }

  if (url.pathname === '/rerun' && req.method === 'GET') {
    const tokenId = url.searchParams.get('token');
    if (!tokenId) {
      notifyFailure({ step: 'rerun', error: 'missing_token', runId: null });
      return json(res, 400, { error: 'missing_token' });
    }
    const result = rerunAction(tokenId);
    const statusCode = result.status === 'invalid' || result.status === 'missing_run' ? 400 : 200;
    return json(res, statusCode, result);
  }

  json(res, 404, { error: 'not_found' });
}

module.exports = { router };
