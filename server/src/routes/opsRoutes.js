// server/src/routes/opsRoutes.js
//
// Ops routes implemented for the repo's current HTTP-router style (NOT Express).
// Export: opsRouter(req, res, url)

const { readStore } = require('../domain/persistenceStore');
const { createRun, appendEvent, updateRun } = require('../domain/runManager');
const { buildOutcome, saveOutcome, getOutcome, updateOutcome } = require('../domain/outcomeService');
const { composeEmail } = require('../domain/emailComposer');
const { sendOutcomeEmail } = require('../domain/emailService');
const { buildArtifacts } = require('../domain/artifactService');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        data = '';
        resolve(null);
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (_) {
        resolve(null);
      }
    });
  });
}

async function handleStatus(req, res) {
  return json(res, 200, { ok: true });
}

async function handleRun(req, res) {
  const body = await parseBody(req);
  if (body === null) return json(res, 400, { ok: false, error: 'invalid_json' });

  const { client_location_id, period_start, period_end, policy_snapshot = null } = body || {};

  if (!client_location_id || !period_start || !period_end) {
    return json(res, 400, { ok: false, error: 'missing_required_fields' });
  }

  const run = createRun({
    client_location_id,
    period_start,
    period_end,
    payload: { policy_snapshot },
    status: 'running',
  });

  appendEvent(run, 'ops_run_created', {});
  updateRun(run.id, { events: run.events });

  // Step 6: validations still placeholders; artifacts now attach to outcome.
  const findings = [];
  const artifacts = buildArtifacts({ run, policySnapshot: policy_snapshot || {} });

  const outcome = buildOutcome(run, findings, artifacts, policy_snapshot);
  outcome.delivery.mode = outcome.delivery.mode || 'internal_only';

  const savedOutcome = saveOutcome(run.id, outcome);

  appendEvent(run, 'ops_outcome_saved', { outcome_status: savedOutcome.status });
  updateRun(run.id, { status: 'completed', events: run.events });

  return json(res, 200, { ok: true, run, outcome: savedOutcome });
}

async function handleRerun(req, res, runId) {
  const id = Number(runId);
  if (!id) return json(res, 400, { ok: false, error: 'invalid_run_id' });

  const store = readStore();
  const previousRun = (store.runs || []).find((r) => Number(r.id) === id);

  if (!previousRun) return json(res, 404, { ok: false, error: 'run_not_found' });

  const policySnapshot = previousRun.payload?.policy_snapshot || null;

  const run = createRun({
    client_location_id: previousRun.client_location_id,
    period_start: previousRun.period_start,
    period_end: previousRun.period_end,
    payload: previousRun.payload || null,
    status: 'running',
  });

  appendEvent(run, 'ops_rerun_created', { previous_run_id: id });
  updateRun(run.id, { events: run.events });

  const findings = [];
  const artifacts = buildArtifacts({ run, policySnapshot: policySnapshot || {} });

  const outcome = buildOutcome(run, findings, artifacts, policySnapshot);
  outcome.delivery.mode = outcome.delivery.mode || 'internal_only';

  const savedOutcome = saveOutcome(run.id, outcome);

  appendEvent(run, 'ops_rerun_outcome_saved', {});
  updateRun(run.id, { status: 'completed', events: run.events });

  return json(res, 200, { ok: true, previous_run_id: id, run, outcome: savedOutcome });
}

async function handleInspect(req, res, runId) {
  const id = Number(runId);
  if (!id) return json(res, 400, { ok: false, error: 'invalid_run_id' });

  const store = readStore();
  const run = (store.runs || []).find((r) => Number(r.id) === id);

  if (!run) return json(res, 404, { ok: false, error: 'run_not_found' });

  const outcome = getOutcome(id);

  return json(res, 200, { ok: true, run, outcome });
}

async function handleRenderEmail(req, res, runId) {
  const id = Number(runId);
  if (!id) return json(res, 400, { ok: false, error: 'invalid_run_id' });

  const store = readStore();
  const run = (store.runs || []).find((r) => Number(r.id) === id);
  const outcome = getOutcome(id);

  if (!run || !outcome) {
    return json(res, 404, { ok: false, error: 'run_or_outcome_not_found' });
  }

  if (!outcome.delivery || outcome.delivery.mode !== 'email') {
    return json(res, 400, { ok: false, error: 'delivery_mode_not_email' });
  }

  const rendered = composeEmail(outcome, run);

  const updated = updateOutcome(id, {
    delivery: {
      subject: rendered.subject,
      rendered_text: rendered.text,
      rendered_html: rendered.html,
    },
  });

  appendEvent(run, 'ops_email_rendered', {});
  updateRun(run.id, { events: run.events });

  return json(res, 200, {
    ok: true,
    run_id: id,
    delivery: {
      subject: updated.delivery.subject,
      rendered_text: updated.delivery.rendered_text,
      rendered_html: updated.delivery.rendered_html,
    },
  });
}

async function handleSendEmail(req, res, runId) {
  const id = Number(runId);
  if (!id) return json(res, 400, { ok: false, error: 'invalid_run_id' });

  const store = readStore();
  const run = (store.runs || []).find((r) => Number(r.id) === id);
  let outcome = getOutcome(id);

  if (!run || !outcome) {
    return json(res, 404, { ok: false, error: 'run_or_outcome_not_found' });
  }

  if (!outcome.delivery || outcome.delivery.mode !== 'email') {
    return json(res, 400, { ok: false, error: 'delivery_mode_not_email' });
  }

  // Ensure rendered content exists; render first if needed.
  if (!outcome.delivery.subject || (!outcome.delivery.rendered_text && !outcome.delivery.rendered_html)) {
    const rendered = composeEmail(outcome, run);
    outcome = updateOutcome(id, {
      delivery: {
        subject: rendered.subject,
        rendered_text: rendered.text,
        rendered_html: rendered.html,
      },
    });

    appendEvent(run, 'ops_email_rendered', { implicit: true });
    updateRun(run.id, { events: run.events });
  }

  const sendResult = await sendOutcomeEmail({ run, outcome });

  if (sendResult.ok) {
    appendEvent(run, sendResult.already_sent ? 'ops_email_already_sent' : 'ops_email_sent', {
      message_id: sendResult.message_id || null,
    });
    updateRun(run.id, { events: run.events });

    const latest = getOutcome(id);

    return json(res, 200, {
      ok: true,
      already_sent: !!sendResult.already_sent,
      message_id: sendResult.message_id || null,
      outcome: latest,
    });
  }

  appendEvent(run, 'ops_email_send_failed', { error: sendResult.error });
  updateRun(run.id, { events: run.events });

  return json(res, 500, { ok: false, error: sendResult.error || 'email_send_failed' });
}

/**
 * opsRouter(req, res, url)
 * url is a WHATWG URL instance from the server entrypoint.
 */
async function opsRouter(req, res, url) {
  const pathname = url.pathname || '';

  if (pathname === '/ops/status' && req.method === 'GET') return handleStatus(req, res);
  if (pathname === '/ops/run' && req.method === 'POST') return handleRun(req, res);

  const rerunMatch = pathname.match(/^\/ops\/rerun\/(\d+)$/);
  if (rerunMatch && req.method === 'POST') return handleRerun(req, res, rerunMatch[1]);

  const inspectMatch = pathname.match(/^\/ops\/run\/(\d+)$/);
  if (inspectMatch && req.method === 'GET') return handleInspect(req, res, inspectMatch[1]);

  const renderMatch = pathname.match(/^\/ops\/render-email\/(\d+)$/);
  if (renderMatch && req.method === 'POST') return handleRenderEmail(req, res, renderMatch[1]);

  const sendMatch = pathname.match(/^\/ops\/send-email\/(\d+)$/);
  if (sendMatch && req.method === 'POST') return handleSendEmail(req, res, sendMatch[1]);

  return json(res, 404, { ok: false, error: 'not_found' });
}

module.exports = { opsRouter };
