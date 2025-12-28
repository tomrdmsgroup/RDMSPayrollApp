// server/src/routes/opsRoutes.js

const express = require('express');

const { readStore } = require('../domain/persistenceStore');
const { createRun, appendEvent, updateRun } = require('../domain/runManager');
const { buildOutcome, saveOutcome, getOutcome, updateOutcome } = require('../domain/outcomeService');
const { composeEmail } = require('../domain/emailComposer');

const router = express.Router();

/**
 * GET /ops/status
 */
router.get('/status', (req, res) => {
  res.json({ ok: true });
});

/**
 * POST /ops/run
 * Run an audit immediately.
 */
router.post('/run', (req, res) => {
  const {
    client_location_id,
    period_start,
    period_end,
    policy_snapshot = null,
  } = req.body || {};

  if (!client_location_id || !period_start || !period_end) {
    return res.status(400).json({ ok: false, error: 'missing_required_fields' });
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

  // Step 4: no real validations yet
  const findings = [];
  const artifacts = [];

  const outcome = buildOutcome(run, findings, artifacts, policy_snapshot);
  outcome.delivery.mode = 'internal_only';

  const savedOutcome = saveOutcome(run.id, outcome);

  appendEvent(run, 'ops_outcome_saved', { outcome_status: savedOutcome.status });
  updateRun(run.id, { status: 'completed', events: run.events });

  res.json({
    ok: true,
    run,
    outcome: savedOutcome,
  });
});

/**
 * POST /ops/rerun/:runId
 */
router.post('/rerun/:runId', (req, res) => {
  const runId = Number(req.params.runId);
  if (!runId) {
    return res.status(400).json({ ok: false, error: 'invalid_run_id' });
  }

  const store = readStore();
  const previousRun = store.runs.find((r) => Number(r.id) === runId);

  if (!previousRun) {
    return res.status(404).json({ ok: false, error: 'run_not_found' });
  }

  const run = createRun({
    client_location_id: previousRun.client_location_id,
    period_start: previousRun.period_start,
    period_end: previousRun.period_end,
    payload: previousRun.payload || null,
    status: 'running',
  });

  appendEvent(run, 'ops_rerun_created', { previous_run_id: runId });
  updateRun(run.id, { events: run.events });

  const findings = [];
  const artifacts = [];

  const outcome = buildOutcome(run, findings, artifacts, previousRun.payload?.policy_snapshot || null);
  outcome.delivery.mode = 'internal_only';

  const savedOutcome = saveOutcome(run.id, outcome);

  appendEvent(run, 'ops_rerun_outcome_saved', {});
  updateRun(run.id, { status: 'completed', events: run.events });

  res.json({
    ok: true,
    previous_run_id: runId,
    run,
    outcome: savedOutcome,
  });
});

/**
 * GET /ops/run/:runId
 */
router.get('/run/:runId', (req, res) => {
  const runId = Number(req.params.runId);
  if (!runId) {
    return res.status(400).json({ ok: false, error: 'invalid_run_id' });
  }

  const store = readStore();
  const run = store.runs.find((r) => Number(r.id) === runId);

  if (!run) {
    return res.status(404).json({ ok: false, error: 'run_not_found' });
  }

  const outcome = getOutcome(runId);

  res.json({
    ok: true,
    run,
    outcome,
  });
});

/**
 * POST /ops/render-email/:runId
 */
router.post('/render-email/:runId', (req, res) => {
  const runId = Number(req.params.runId);
  if (!runId) {
    return res.status(400).json({ ok: false, error: 'invalid_run_id' });
  }

  const store = readStore();
  const run = store.runs.find((r) => Number(r.id) === runId);
  const outcome = getOutcome(runId);

  if (!run || !outcome) {
    return res.status(404).json({ ok: false, error: 'run_or_outcome_not_found' });
  }

  if (!outcome.delivery || outcome.delivery.mode !== 'email') {
    return res.status(400).json({ ok: false, error: 'delivery_mode_not_email' });
  }

  const rendered = composeEmail(outcome, run);

  const updated = updateOutcome(runId, {
    delivery: {
      subject: rendered.subject,
      rendered_text: rendered.text,
      rendered_html: rendered.html,
    },
  });

  appendEvent(run, 'ops_email_rendered', {});
  updateRun(run.id, { events: run.events });

  res.json({
    ok: true,
    run_id: runId,
    delivery: {
      subject: updated.delivery.subject,
      rendered_text: updated.delivery.rendered_text,
      rendered_html: updated.delivery.rendered_html,
    },
  });
});

/**
 * POST /ops/send-email/:runId
 * Stub for Step 4.
 */
router.post('/send-email/:runId', (req, res) => {
  res.status(501).json({
    ok: false,
    error: 'email_send_not_implemented',
  });
});

module.exports = router;
