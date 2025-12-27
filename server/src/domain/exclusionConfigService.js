// server/src/domain/exclusionConfigService.js
// Persistence-backed exclusions CRUD per client_location_id.

const { readStore, writeStore, nextId } = require('./persistenceStore');

function normalizeScopeFlags(flags) {
  // Preserve legacy semantics:
  // - null/undefined => treated by exclusionsService as exclude-all
  // - object => only explicit true flags exclude
  if (flags == null) return null;
  if (typeof flags !== 'object') return {};
  const normalized = {};
  ['audit', 'wip', 'tips'].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      normalized[key] = flags[key] === true;
    }
  });
  return normalized;
}

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
    effective_from: input.effective_from ? `${input.effective_from}`.trim() : null,
    effective_to: input.effective_to ? `${input.effective_to}`.trim() : null,
    scope_flags: normalizeScopeFlags(input.scope_flags),
    notes: input.notes ? `${input.notes}`.trim() : null,
  };
}

function listExclusionsForLocation(clientLocationId) {
  const data = readStore();
  const rows = data.exclusions.filter((ex) => Number(ex.client_location_id) === Number(clientLocationId));
  rows.sort((a, b) => {
    const an = `${a.employee_name || ''}`.toLowerCase();
    const bn = `${b.employee_name || ''}`.toLowerCase();
    if (an !== bn) return an.localeCompare(bn);
    return `${a.toast_employee_id}`.localeCompare(`${b.toast_employee_id}`);
  });
  return rows;
}

function createExclusion(input = {}) {
  const data = readStore();
  const normalized = normalize(input);
  const now = new Date().toISOString();

  const row = {
    ...normalized,
    id: nextId(data.exclusions),
    created_at: now,
    updated_at: now,
  };

  data.exclusions.push(row);
  writeStore(data);
  return row;
}

function getExclusion(id) {
  const data = readStore();
  return data.exclusions.find((ex) => Number(ex.id) === Number(id)) || null;
}

function updateExclusion(id, input = {}) {
  const data = readStore();
  const idx = data.exclusions.findIndex((ex) => Number(ex.id) === Number(id));
  if (idx === -1) return null;

  const existing = data.exclusions[idx];

  // client_location_id is immutable on update
  const sanitizedInput = { ...input };
  delete sanitizedInput.client_location_id;
  delete sanitizedInput.id;
  delete sanitizedInput.created_at;
  delete sanitizedInput.updated_at;

  const merged = { ...existing, ...sanitizedInput, client_location_id: existing.client_location_id };
  const normalized = normalize(merged);

  const row = {
    ...existing,
    ...normalized,
    id: existing.id,
    client_location_id: existing.client_location_id,
    created_at: existing.created_at,
    updated_at: new Date().toISOString(),
  };

  data.exclusions[idx] = row;
  writeStore(data);
  return row;
}

function deleteExclusion(id) {
  const data = readStore();
  const before = data.exclusions.length;
  data.exclusions = data.exclusions.filter((ex) => Number(ex.id) !== Number(id));
  writeStore(data);
  return data.exclusions.length < before;
}

module.exports = {
  listExclusionsForLocation,
  createExclusion,
  getExclusion,
  updateExclusion,
  deleteExclusion,
};
