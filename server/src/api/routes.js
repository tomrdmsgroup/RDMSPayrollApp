// server/src/api/routes.js

const { authenticate, seedAdmin } = require('../domain/authService');
const { issueToken } = require('../domain/tokenService');
const { createRunRecord, appendEvent, failRun, getRun } = require('../domain/runManager');
const { approveAction, rerunAction } = require('../domain/approvalService');
const { IdempotencyService } = require('../domain/idempotencyService');
const { notifyFailure } = require('../domain/failureService');
const { runValidation } = require('../domain/validationEngine');

const {
  createClientLocation,
  listClientLocations,
  updateClientLocation,
  deleteClientLocation,
} = require('../domain/clientLocationService');

const {
  listExclusionsForLocation,
  createExclusion,
  updateExclusion,
  deleteExclusion,
} = require('../domain/exclusionConfigService');

const {
  getRuleConfigsForLocation,
  setRuleConfig,
  deleteRuleConfig,
} = require('../domain/ruleConfigService');

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

function handleError(res, err) {
  if (err && err.message === 'persistence_store_corrupt') {
    // System failure: persistence store unreadable. Do not silently reset.
    return json(res, 500, {
      error: 'persistence_store_corrupt',
      backup: err.backup || null,
    });
  }
  return json(res, 500, { error: err?.message || 'unknown_error' });
}

function router(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') return json(res, 200, { ok: true });

  // -----------------------
  // Auth (stubbed)
  // -----------------------
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

  // -----------------------
  // Tokens
  // -----------------------
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

  // -----------------------
  // Client Locations (persistence-backed)
  // -----------------------
  if (url.pathname === '/client-locations' && req.method === 'GET') {
    try {
      const activeOnly = url.searchParams.get('activeOnly');
      const rows = listClientLocations({
        activeOnly: activeOnly === null ? true : activeOnly !== 'false',
      });
      return json(res, 200, { client_locations: rows });
    } catch (e) {
      return handleError(res, e);
    }
  }

  if (url.pathname === '/client-locations' && req.method === 'POST') {
    parseBody(req).then((body) => {
      try {
        const row = createClientLocation(body);
        return json(res, 201, { client_location: row });
      } catch (e) {
        if (e && e.message === 'persistence_store_corrupt') return handleError(res, e);
        return json(res, 400, { error: e.message });
      }
    });
    return;
  }

  if (url.pathname.startsWith('/client-locations/') && req.method === 'PUT') {
    const id = url.pathname.split('/')[2];
    parseBody(req).then((body) => {
      try {
        const row = updateClientLocation(id, body);
        if (!row) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { client_location: row });
      } catch (e) {
        if (e && e.message === 'persistence_store_corrupt') return handleError(res, e);
        return json(res, 400, { error: e.message });
      }
    });
    return;
  }

  if (url.pathname.startsWith('/client-locations/') && req.method === 'DELETE') {
    try {
      const id = url.pathname.split('/')[2];
      const ok = deleteClientLocation(id);
      return json(res, 200, { deleted: ok === true });
    } catch (e) {
      return handleError(res, e);
    }
  }

  // -----------------------
  // Rule Configs (persistence-backed)
  // -----------------------
  // GET /rule-configs?clientLocationId=#
  if (url.pathname === '/rule-configs' && req.method === 'GET') {
    try {
      const clientLocationId = url.searchParams.get('clientLocationId');
      if (!clientLocationId) return json(res, 400, { error: 'clientLocationId_required' });
      const rows = getRuleConfigsForLocation(clientLocationId);
      return json(res, 200, { rule_configs: rows });
    } catch (e) {
      return handleError(res, e);
    }
  }

  // PUT /rule-configs?clientLocationId=#&ruleCode=CODE
  if (url.pathname === '/rule-configs' && req.method === 'PUT') {
    const clientLocationId = url.searchParams.get('clientLocationId');
    const ruleCode = url.searchParams.get('ruleCode');
    if (!clientLocationId) return json(res, 400, { error: 'clientLocationId_required' });
    if (!ruleCode) return json(res, 400, { error: 'ruleCode_required' });

    parseBody(req).then((body) => {
      try {
        const row = setRuleConfig(clientLocationId, ruleCode, body);
        return json(res, 200, { rule_config: row });
      } catch (e) {
        if (e && e.message === 'persistence_store_corrupt') return handleError(res, e);
        return json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // DELETE /rule-configs?clientLocationId=#&ruleCode=CODE
  if (url.pathname === '/rule-configs' && req.method === 'DELETE') {
    try {
      const clientLocationId = url.searchParams.get('clientLocationId');
      const ruleCode = url.searchParams.get('ruleCode');
      if (!clientLocationId) return json(res, 400, { error: 'clientLocationId_required' });
      if (!ruleCode) return json(res, 400, { error: 'ruleCode_required' });
      const ok = deleteRuleConfig(clientLocationId, ruleCode);
      return json(res, 200, { deleted: ok === true });
    } catch (e) {
      return handleError(res, e);
    }
  }

  // -----------------------
  // Exclusions (persistence-backed)
  // -----------------------
  // GET /exclusions?clientLocationId=#
  if (url.pathname === '/exclusions' && req.method === 'GET') {
    try {
      const clientLocationId = url.searchParams.get('clientLocationId');
      if (!clientLocationId) return json(res, 400, { error: 'clientLocationId_required' });
      const rows = listExclusionsForLocation(clientLocationId);
      return json(res, 200, { exclusions: rows });
    } catch (e) {
      return handleError(res, e);
    }
  }

  // POST /exclusions?clientLocationId=#
  if (url.pathname === '/exclusions' && req.method === 'POST') {
    const clientLocationId = url.searchParams.get('clientLocationId');
    if (!clientLocationId) return json(res, 400, { error: 'clientLocationId_required' });

    parseBody(req).then((body) => {
      try {
        const row = createExclusion(clientLocationId, body);
        return json(res, 201, { exclusion: row });
      } catch (e) {
        if (e && e.message === 'persistence_store_corrupt') return handleError(res, e);
        return json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // PUT /exclusions?id=#
  if (url.pathname === '/exclusions' && req.method === 'PUT') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { error: 'id_required' });

    parseBody(req).then((body) => {
      try {
        const row = updateExclusion(id, body);
        if (!row) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { exclusion: row });
      } catch (e) {
        if (e && e.message === 'persistence_store_corrupt') return handleError(res, e);
        return json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // DELETE /exclusions?id=#
  if (url.pathname === '/exclusions' && req.method === 'DELETE') {
    try {
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: 'id_required' });
      const ok = deleteExclusion(id);
      return json(res, 200, { deleted: ok === true });
    } catch (e) {
      return handleError(res, e);
    }
  }

  // -----------------------
  // Validation
  // -----------------------
  // POST /validate (body: { clientLocationId, periodStart, periodEnd })
  if (url.pathname === '/validate' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      try {
        const run = createRunRecord({
          clientLocationId: body.clientLocationId,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
        });

        appendEvent(run, 'validation_requested', { at: new Date().toISOString() });

        try {
          const result = await runValidation(run);
          appendEvent(run, 'validation_completed', { ok: true });
          return json(res, 200, { run, result });
        } catch (e) {
          failRun(run, e);
          notifyFailure({ step: 'validation', error: e.message, runId: run.id });
          return json(res, 500, { error: e.message, run_id: run.id });
        }
      } catch (e) {
        notifyFailure({ step: 'validation', error: e.message, runId: null });
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // -----------------------
  // Run (read-only convenience)
  // -----------------------
  // GET /run?id=#
  if (url.pathname === '/run' && req.method === 'GET') {
    try {
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: 'id_required' });
      const run = getRun(id);
      if (!run) return json(res, 404, { error: 'not_found' });
      return json(res, 200, { run });
    } catch (e) {
      return handleError(res, e);
    }
  }

  // -----------------------
  // Idempotency
  // -----------------------
  if (url.pathname === '/idempotency/check' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      const exists = idempotency.check(body.scope, body.key);
      if (exists) return json(res, 200, { reused: true });
      idempotency.record(body.scope, body.key);
      json(res, 200, { reused: false });
    });
    return;
  }

  // -----------------------
  // Approve / Rerun
  // -----------------------
  if (url.pathname === '/approve' && req.method === 'GET') {
    const tokenId = url.searchParams.get('token');
    if (!tokenId) {
      notifyFailure({ step: 'approve', error: 'missing_token', runId: null });
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;">Missing token.</body></html>');
      return;
    }

    approveAction(tokenId)
      .then((result) => {
        const statusCode = result && result.ok === false ? 400 : 200;
        res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(result.html || '');
      })
      .catch((e) => {
        notifyFailure({ step: 'approve', error: e?.message || 'approve_failed', runId: null });
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;">Server error.</body></html>');
      });

    return;
  }

  if (url.pathname === '/rerun' && req.method === 'GET') {
    const tokenId = url.searchParams.get('token');
    if (!tokenId) {
      notifyFailure({ step: 'rerun', error: 'missing_token', runId: null });
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;">Missing token.</body></html>');
      return;
    }

    rerunAction(tokenId)
      .then((result) => {
        const statusCode = result && result.ok === false ? 400 : 200;
        res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(result.html || '');
      })
      .catch((e) => {
        notifyFailure({ step: 'rerun', error: e?.message || 'rerun_failed', runId: null });
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;">Server error.</body></html>');
      });

    return;
  }

  json(res, 404, { error: 'not_found' });
}

module.exports = { router };
