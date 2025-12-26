// server/src/domain/clientLocationService.js
// In-memory client/location store (Airtable comes later).

const store = new Map(); // id -> { id, name, vitals_record_id, timezone, active }
let counter = 1;

function normalize(input = {}) {
  const name = `${input.name || ''}`.trim();
  if (!name) throw new Error('name_required');

  return {
    name,
    vitals_record_id: input.vitals_record_id ? `${input.vitals_record_id}`.trim() : '',
    timezone: input.timezone ? `${input.timezone}`.trim() : null,
    active: input.active !== false, // default true
  };
}

function createClientLocation(input = {}) {
  const normalized = normalize(input);
  const id = counter++;
  const row = { id, ...normalized };
  store.set(id, row);
  return row;
}

function getClientLocation(id) {
  return store.get(Number(id)) || null;
}

function listClientLocations({ activeOnly = true } = {}) {
  const rows = Array.from(store.values()).filter((r) => (activeOnly ? r.active === true : true));
  rows.sort((a, b) => `${a.name}`.localeCompare(`${b.name}`));
  return rows;
}

function updateClientLocation(id, input = {}) {
  const existing = getClientLocation(id);
  if (!existing) return null;

  const merged = {
    ...existing,
    ...input,
  };

  const normalized = normalize(merged);
  const row = { ...existing, ...normalized, id: existing.id };
  store.set(existing.id, row);
  return row;
}

function deleteClientLocation(id) {
  return store.delete(Number(id));
}

module.exports = {
  createClientLocation,
  getClientLocation,
  listClientLocations,
  updateClientLocation,
  deleteClientLocation,
};
                                                                                                                                                     
