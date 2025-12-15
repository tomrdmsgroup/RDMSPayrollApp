const { notifyFailure } = require('./failureService');

function createRunRecord({ clientLocationId, periodStart, periodEnd }) {
  return {
    id: Math.floor(Math.random() * 100000),
    client_location_id: clientLocationId,
    period_start: periodStart,
    period_end: periodEnd,
    status: 'created',
    events: [],
  };
}

function appendEvent(run, eventType, payload = {}) {
  run.events.push({ event_type: eventType, payload, occurred_at: new Date() });
}

function failRun(run, step, error) {
  run.status = 'failed';
  run.error_message = error;
  appendEvent(run, 'failure', { step, error });
  notifyFailure({ clientLocation: run.client_location_id, period: `${run.period_start} - ${run.period_end}`, step, error, runId: run.id });
}

module.exports = { createRunRecord, appendEvent, failRun };
