// server/src/domain/clientLocationService.js
// Persistence-backed client/location store (Airtable provider later).

const { readStore, writeStore, nextId } = require('./persistenceStore');

function normalize(input = {}) {
  const name = `${input.name || ''}`.trim();
  if (!name) throw new Error('name_required');

  const vitals_record_id = input.vitals_record_id ? `${input.vitals_record_id}`.trim() : '';
  const timezone = input.timezone ? `${input.timezone}`.trim() : null;
  const active = input.active !== false;

  return {
    name,
    vitals_record_id,
    timezone,
    active,
  };
}

function createClientLocation(input = {}) {
  const data = readStore();
  const normalized = normalize(input);
  const now = new Date().toISOString();

  const row = {
    ...normalized,
    id: nextId(data.client_locations),
    created_at: now,
    updated_at: now,
  };

  data.client_locations.push(row);
  writeStore(data);
  return row;
}

function getClientLocation(id) {
  const data = readStore();
  return data.client_locations.find((r) => Number(r.id) === Number(id)) || null;
}

function listClientLocations({ activeOnly = true } = {}) {
  const data = readStore();
  const rows = data.client_locations.filter((r) => (activeOnly ? r.active === true : true));
  rows.sort((a, b) => `${a.name}`.localeCompare(`${b.name}`));
  return rows;
}

function updateClientLocation(id, input = {}) {
  const data = readStore();
  const idx = data.client_locations.findIndex((r) => Number(r.id) === Number(id));
  if (idx === -1) return null;

  const existing = data.client_locations[idx];
  const sanitizedInput = { ...input };
  delete sanitizedInput.id;
  delete sanitizedInput.created_at;
  delete sanitizedInput.updated_at;

  const merged = { ...existing, ...sanitizedInput, id: existing.id };
  const normalized = normalize(merged);

  const row = {
    ...existing,
    ...normalized,
    id: existing.id,
    created_at: existing.created_at,
    updated_at: new Date().toISOString(),
  };

  data.client_locations[idx] = row;
  writeStore(data);
  return row;
}

function deleteClientLocation(id) {
  const data = readStore();
  const before = data.client_locations.length;
  data.client_locations = data.client_locations.filter((r) => Number(r.id) !== Number(id));
  writeStore(data);
  return data.client_locations.length < before;
}

function seedClientLocations(rows = []) {
  const data = readStore();
  let changed = false;

  rows.forEach((row) => {
    try {
      const normalized = normalize(row);
      const exists = data.client_locations.find(
        (r) => `${r.name}`.toLowerCase() === `${normalized.name}`.toLowerCase()
      );
      if (exists) return;

      const now = new Date().toISOString();
      data.client_locations.push({
        ...normalized,
        id: nextId(data.client_locations),
        created_at: now,
        updated_at: now,
      });
      changed = true;
    } catch (_) {
      // ignore invalid seed rows
    }
  });

  if (changed) writeStore(data);
  return listClientLocations({ activeOnly: false });
}

module.exports = {
  createClientLocation,
  getClientLocation,
  listClientLocations,
  updateClientLocation,
  deleteClientLocation,
  seedClientLocations,
};
