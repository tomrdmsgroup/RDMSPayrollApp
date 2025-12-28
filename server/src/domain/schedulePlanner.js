// server/src/domain/schedulePlanner.js

/**
 * Schedule Planner
 *
 * Converts policy snapshots + current time into a list of intended actions.
 * Does NOT execute actions.
 *
 * Intended actions:
 * - RUN_AUDIT
 * - SEND_EMAIL
 */

function nowIso() {
  return new Date().toISOString();
}

/**
 * Compute a stable run key for uniqueness checks.
 */
function runKey({ client_location_id, period_start, period_end }) {
  return `${client_location_id}|${period_start}|${period_end}`;
}

/**
 * Determine whether a run already exists for a given client/location + period.
 */
function runExists(runs, key) {
  return runs.some((r) => runKey(r) === key);
}

/**
 * Plan audit runs.
 *
 * policySnapshots: array of per-client/location policy objects
 * runs: durable runs from store
 */
function planRuns({ policySnapshots = [], runs = [] }) {
  const actions = [];

  for (const policy of policySnapshots) {
    if (policy?.automation_enabled === false) continue;

    const {
      client_location_id,
      period_start,
      period_end,
    } = policy || {};

    if (!client_location_id || !period_start || !period_end) continue;

    const key = runKey({ client_location_id, period_start, period_end });
    if (runExists(runs, key)) continue;

    actions.push({
      type: 'RUN_AUDIT',
      client_location_id,
      period_start,
      period_end,
      policy_snapshot: policy,
      planned_at: nowIso(),
    });
  }

  return actions;
}

/**
 * Plan email sends.
 *
 * outcomes: durable outcomes from store
 * now: Date object representing "current time"
 */
function planEmails({ outcomes = [], now = new Date() }) {
  const actions = [];

  const nowMs = now.getTime();

  for (const outcome of outcomes) {
    const delivery = outcome?.delivery;
    if (!delivery) continue;

    if (delivery.mode !== 'email') continue;
    if (delivery.sent_at) continue;
    if (!delivery.scheduled_send_at) continue;

    const sendAtMs = new Date(delivery.scheduled_send_at).getTime();
    if (!Number.isFinite(sendAtMs)) continue;

    if (nowMs >= sendAtMs) {
      actions.push({
        type: 'SEND_EMAIL',
        run_id: outcome.run_id,
        planned_at: nowIso(),
      });
    }
  }

  return actions;
}

/**
 * Plan all intended actions.
 */
function planAll({ policySnapshots = [], runs = [], outcomes = [], now = new Date() }) {
  return [
    ...planRuns({ policySnapshots, runs }),
    ...planEmails({ outcomes, now }),
  ];
}

module.exports = {
  planRuns,
  planEmails,
  planAll,
  runKey,
};
