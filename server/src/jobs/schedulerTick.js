// server/src/jobs/schedulerTick.js

const { readStore } = require('../domain/persistenceStore');
const { planAll } = require('../domain/schedulePlanner');
const { notifyFailure } = require('../domain/failureService');
const { IdempotencyService } = require('../domain/idempotencyService');
const { createRun, appendEvent, updateRun } = require('../domain/runManager');
const { buildOutcome, saveOutcome, updateOutcome } = require('../domain/outcomeService');
const { composeEmail } = require('../domain/emailComposer');
const { buildArtifacts } = require('../domain/artifactService');

/**
 * Placeholder: load policy snapshots.
 * Step 6 still assumes policy snapshots exist. This function returns an array.
 * In later steps, this will be wired to Airtable reads.
 */
async function loadPolicySnapshots() {
  return [];
}

function nowIso() {
  return new Date().toISOString();
}

function actionKey(action) {
  if (action.type === 'RUN_AUDIT') {
    return `RUN_AUDIT|${action.client_location_id}|${action.period_start}|${action.period_end}`;
  }
  if (action.type === 'SEND_EMAIL') {
    return `SEND_EMAIL|${action.run_id}`;
  }
  return `ACTION|${action.type}`;
}

/**
 * Execute a planned RUN_AUDIT action.
 * Step 6: persist run + create an outcome skeleton, now including artifacts.
 */
async function executeRunAudit(action) {
  const run = createRun({
    client_location_id: action.client_location_id,
    period_start: action.period_start,
    period_end: action.period_end,
    payload: { policy_snapshot: action.policy_snapshot || null },
    status: 'running',
  });

  appendEvent(run, 'scheduler_run_created', { planned_at: action.planned_at });
  updateRun(run.id, { events: run.events });

  // Step 6: validations still placeholders; artifacts attach to outcome.
  const findings = [];
  const artifacts = buildArtifacts({ run, policySnapshot: action.policy_snapshot || {} });

  const outcome = buildOutcome(run, findings, artifacts, action.policy_snapshot || null);

  // Delivery mode will be set by future policy wiring. Default internal_only for now.
  outcome.delivery.mode = 'internal_only';

  const saved = saveOutcome(run.id, outcome);

  appendEvent(run, 'outcome_saved', { outcome_status: saved?.status || null });
  updateRun(run.id, { status: 'completed', events: run.events });

  return { run, outcome: saved };
}

/**
 * Execute a planned SEND_EMAIL action.
 * Step 6: compose and store rendered bodies; actual sending is handled elsewhere.
 */
async function executeSendEmail(action) {
  const store = readStore();
  const run = store.runs.find((r) => Number(r.id) === Number(action.run_id));
  const outcome = store.outcomes.find((o) => Number(o.run_id) === Number(action.run_id));

  if (!run || !outcome) {
    notifyFailure({
      step: 'scheduler_send_email',
      error: 'missing_run_or_outcome',
      runId: action.run_id,
    });
    return null;
  }

  if (!outcome.delivery || outcome.delivery.mode !== 'email') {
    return null;
  }

  // Compose and persist rendered content.
  const rendered = composeEmail(outcome, run);

  const updated = updateOutcome(run.id, {
    delivery: {
      subject: rendered.subject,
      rendered_text: rendered.text,
      rendered_html: rendered.html,
    },
  });

  appendEvent(run, 'email_rendered', { rendered_at: nowIso() });
  updateRun(run.id, { events: run.events });

  return { run, outcome: updated };
}

/**
 * schedulerTick()
 *
 * Returns summary:
 * - planned actions
 * - executed actions
 * - failures encountered (count)
 */
async function schedulerTick({ now = new Date() } = {}) {
  const idempotency = new IdempotencyService();
  const executed = [];
  let planned = [];
  let failures = 0;

  try {
    const store = readStore();
    const policySnapshots = await loadPolicySnapshots();

    planned = planAll({
      policySnapshots,
      runs: store.runs || [],
      outcomes: store.outcomes || [],
      now,
    });

    for (const action of planned) {
      const key = actionKey(action);

      const ok = idempotency.record('scheduler_action', key);
      if (!ok) continue;

      try {
        if (action.type === 'RUN_AUDIT') {
          const res = await executeRunAudit(action);
          executed.push({ type: action.type, key, run_id: res?.run?.id || null });
        } else if (action.type === 'SEND_EMAIL') {
          const res = await executeSendEmail(action);
          executed.push({ type: action.type, key, run_id: res?.run?.id || action.run_id || null });
        } else {
          // Unknown action: ignore safely
        }
      } catch (err) {
        failures += 1;
        notifyFailure({
          step: 'scheduler_action_execute',
          error: err?.message || 'action_failed',
          action,
        });
      }
    }

    return {
      ok: true,
      planned_count: planned.length,
      executed_count: executed.length,
      planned,
      executed,
      failures,
    };
  } catch (err) {
    failures += 1;
    notifyFailure({
      step: 'scheduler_tick',
      error: err?.message || 'scheduler_tick_failed',
    });

    return {
      ok: false,
      planned_count: planned.length,
      executed_count: executed.length,
      planned,
      executed,
      failures,
    };
  }
}

module.exports = {
  schedulerTick,
};
