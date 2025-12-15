const { notifyFailure } = require('./failureService');

const runStore = new Map();
let runCounter = 1;

function createRunRecord({ clientLocationId, periodStart, periodEnd }) {
  const run = {
    id: runCounter++,
    client_location_id: clientLocationId,
    period_start: periodStart,
    period_end: periodEnd,
    status: 'created',
    events: [],
    locked: false,
  };
  runStore.set(run.id, run);
  return run;
}

function appendEvent(run, eventType, payload = {}) {
  if (!run) return;
  run.events.push({ event_type: eventType, payload, occurred_at: new Date() });
}

function getRun(runId) {
  return runStore.get(runId) || null;
}

function lockRun(run, reason = {}) {
  if (!run) return { locked: false, reason: 'missing_run' };
  if (run.locked) return { locked: false, reason: 'already_locked', run };
  run.locked = true;
  run.locked_at = new Date();
  run.lock_reason = reason;
  run.status = 'locked';
  appendEvent(run, 'locked', { reason });
  return { locked: true, run };
}

function failRun(run, step, error) {
  if (run) {
    run.status = 'failed';
    run.error_message = error;
    appendEvent(run, 'failure', { step, error });
  }
  notifyFailure({ clientLocation: run ? run.client_location_id : null, period: run ? `${run.period_start} - ${run.period_end}` : '', step, error, runId: run ? run.id : null });
}

function resetRuns() {
  runStore.clear();
  runCounter = 1;
}

module.exports = { createRunRecord, appendEvent, failRun, getRun, lockRun, resetRuns, runStore };
