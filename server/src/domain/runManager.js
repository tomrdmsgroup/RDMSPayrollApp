// server/src/domain/runManager.js

const { query } = require('./db');

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

async function createRun({ client_location_id, period_start, period_end, payload = null, status = 'created' }) {
  const run = {
    id: null,
    client_location_id,
    period_start,
    period_end,
    status,
    created_at: nowIso(),
    updated_at: nowIso(),
    payload,
    events: [],
  };

  const r = await query(
    `INSERT INTO ops_runs (run, created_at, updated_at) VALUES ($1::jsonb, NOW(), NOW()) RETURNING id`,
    [run],
  );

  run.id = Number(r.rows[0].id);

  // Update stored JSON to include the assigned id.
  await query(`UPDATE ops_runs SET run = $1::jsonb, updated_at = NOW() WHERE id = $2`, [run, run.id]);

  return run;
}

async function getRunById(runId) {
  const id = Number(runId);
  if (!id) return null;

  const r = await query(`SELECT run FROM ops_runs WHERE id = $1`, [id]);
  if (!r.rows.length) return null;
  return r.rows[0].run || null;
}

async function updateRun(runId, patch) {
  const id = Number(runId);
  if (!id) return null;

  const existing = await getRunById(id);
  if (!existing) return null;

  const next = { ...existing, ...(patch || {}), updated_at: nowIso() };

  await query(`UPDATE ops_runs SET run = $1::jsonb, updated_at = NOW() WHERE id = $2`, [next, id]);
  return next;
}

async function listRuns({ limit = 50 } = {}) {
  const lim = Number(limit) || 50;
  const r = await query(`SELECT run FROM ops_runs ORDER BY id DESC LIMIT $1`, [lim]);
  return r.rows.map((row) => row.run).filter(Boolean);
}

module.exports = {
  nowIso,
  createRun,
  getRunById,
  updateRun,
  listRuns,
  appendEvent,
};
