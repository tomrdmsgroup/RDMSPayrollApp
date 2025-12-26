// server/src/domain/exclusionConfigService.js
// In-memory exclusions CRUD per client_location_id.
// NOTE: "exclusionsService.js" remains the pure logic layer.
// This file is storage only.

const store = new Map(); // id -> exclusion row
let counter = 1;

function normalize(input = {}) {
  const client_location_id = Number(input.client_location_id);
  if (!client_location_id) throw new Error('client_location_id_required');

  const toast_employee_id = `${input.toast_employee_id || ''}`.trim();
  if (!toast_employee_id) throw new Error('toast_employee_id_required');

  return {
    client_location_id,
    employee_name: input.employee_name ? `${input.employee_name}`.trim() : null,
    reason: input.reason ? `${input.reason}`.trim() : null,
    toast_employee_id,
    effective_from: input.effective_from ? `${input.effective_from}`.trim() : null, // "YYYY-MM-DD"
    effective_to: input.effective_to ? `${input.effective_to}`.trim() : null, // "YYYY-MM-DD"
    scope_flags: input.scope_flags && typeof input.scope_flags === 'object' ? input.scope_flags : {},
    notes: input.notes ? `${input.notes}`.trim() : null,
  };
}

function listExclusionsForLocation(clientLocationId) {
  const cid = Number(clientLocationId);
  const rows = [];
  for (const ex of store.values()) {
    if (Number(ex.client_location_id) === cid) rows.push(ex);
  }
  // stable ordering for UI: employee_name then toast_employee_id
  rows.sort((a, b) => {
    const an = `${a.employee_name || ''}`.toLowerCase();
    const bn = `${b.employee_name || ''}`.toLowerCase();
    if (an !== bn) return an.localeCompare(bn);
    return `${a.toast_employee_id}`.localeCompare(`${b.toast_employee_id}`);
  });
  return rows;
}

function createExclusion(input = {}) {
  const normalized = normalize(input);
  const id = counter++;
  const row = { id, ...normalized };
  store.set(id, row);
  return row;
}

function getExclusion(id) {
  return store.get(Number(id)) || null;
}

function updateExclusion(id, input = {}) {
  const existing = getExclusion(id);
  if (!existing) return null;

  const merged = { ...existing, ...input, id: existing.id, client_location_id: existing.client_location_id };
  const normalized = normalize(merged);
  const row = { id: existing.id, ...normalized };
  store.set(existing.id, row);
  return row;
}

function deleteExclusion(id) {
  return store.delete(Number(id));
}

module.exports = {
  listExclusionsForLocation,
  createExclusion,
  getExclusion,
  updateExclusion,
  deleteExclusion,
};
