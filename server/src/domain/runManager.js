// server/src/domain/runManager.js

const { updateStore, nextCounter } = require('./persistenceStore');

function nowIso() {
  return new Date().toISOString();
}

function ensureEvents(run) {
  if (!run.events || !Array.isArray(run.events)) run.events = [];
  return run;
}

function appendEvent(run, type, data) {
  if (!run) return run;
  ensureEvents(run);
  run.events.push({
    occurred_at: nowIso(),
    type,
    data: data || null,
  });
  return run;
}

function createRun({
  client_location_id,
  period_start,
  period_end,
  payload = null,
  status = 'created',
}) {
  let createdRun = null;

  updateStore((store) => {
    const id = nextCounter(store, 'run_id');

    createdRun = {
      id,
      client_location_id,
      period_start,
      period_end,
      status,
      created_at: nowIso(),
      updated_at: nowIso(),
      payload,
      events: [],
    };

    store.runs.push(createdRun);
    return store;
  });

  return createdRun;
}

function getRunById(runId) {
  const id = Number(runId);
  let found = null;

  updateStore((store) => {
    found = store.runs.find((r) => Number(r.id) === id) || null;
    return store;
  });

  return found;
}

function updateRun(runId, patch) {
  const id = Number(runId);
  let updated = null;

  updateStore((store) => {
    const run = store.runs.find((r) => Number(r.id) === id);
    if (!run) {
      updated = null;
      return store;
    }

    Object.assign(run, patch || {});
    run.updated_at = nowIso();

    updated = run;
    return store;
  });

  return updated;
}

function listRuns({ limit = 50 } = {}) {
  let rows = [];

  updateStore((store) => {
    const sorted = [...store.runs].sort((a, b) => Number(b.id) - Number(a.id));
    rows = sorted.slice(0, Number(limit) || 50);
    return store;
  });

  return rows;
}

module.exports = {
  nowIso,
  createRun,
  getRunById,
  updateRun,
  listRuns,
  appendEvent,
};
