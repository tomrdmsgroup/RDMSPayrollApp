// server/src/providers/vitalsProvider.js

const { fetchAirtableRecords, enforceRequiredFields } = require('./airtableClient');

const DEFAULT_AIRTABLE_META_URL = 'https://api.airtable.com/v0/meta';

function getAirtableConfig() {
  const baseId = process.env.AIRTABLE_VITALS_BASE;
  const apiKey = process.env.AIRTABLE_VITALS_API_KEY || process.env.AIRTABLE_API_KEY;

  // IMPORTANT:
  // This must match your Airtable TABLE name EXACTLY.
  // Your base screenshot strongly suggests the table is "Client Vitals Database".
  const tableName = process.env.AIRTABLE_VITALS_TABLE || 'Vitals';

  return { baseId, apiKey, tableName };
}

async function fetchVitalsSnapshot(clientLocationId) {
  const { baseId, apiKey, tableName } = getAirtableConfig();

  const filterByFormula = clientLocationId ? `{client_location_id} = '${clientLocationId}'` : undefined;

  const { records, endpoint } = await fetchAirtableRecords({ baseId, tableName, apiKey, filterByFormula });

  const requiredFields = ['client_location_id'];

  const data = records.map((record) => {
    enforceRequiredFields(record, requiredFields);
    return {
      id: record.id,
      ...record.fields,
    };
  });

  return {
    fetched_at: new Date().toISOString(),
    client_location_id: clientLocationId || null,
    endpoint,
    count: data.length,
    data,
  };
}

// NEW: Fetch Airtable schema (tables + fields) so we can confirm exact table names.
async function fetchVitalsSchema() {
  const { baseId, apiKey } = getAirtableConfig();

  if (!baseId) throw new Error('airtable_base_required');
  if (!apiKey) throw new Error('airtable_api_key_required');

  const url = new URL(`${DEFAULT_AIRTABLE_META_URL}/bases/${baseId}/tables`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch (_) {
      body = null;
    }
    const message = body?.error?.message || body?.error || `airtable_meta_error_${response.status}`;
    throw new Error(message);
  }

  const json = await response.json();
  const tables = Array.isArray(json?.tables) ? json.tables : [];

  return {
    fetched_at: new Date().toISOString(),
    base_id: baseId,
    table_names: tables.map((t) => t.name),
    tables: tables.map((t) => ({
      id: t.id,
      name: t.name,
      primaryFieldId: t.primaryFieldId || null,
      fields: Array.isArray(t.fields)
        ? t.fields.map((f) => ({ id: f.id, name: f.name, type: f.type }))
        : [],
    })),
  };
}

module.exports = { fetchVitalsSnapshot, fetchVitalsSchema };
