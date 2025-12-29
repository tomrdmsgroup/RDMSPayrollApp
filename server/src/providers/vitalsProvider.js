// server/src/providers/vitalsProvider.js

const { fetchAirtableRecords, enforceRequiredFields } = require('./airtableClient');

const DEFAULT_AIRTABLE_META_URL = 'https://api.airtable.com/v0/meta';

function getAirtableConfig() {
  const baseId = process.env.AIRTABLE_VITALS_BASE;
  const apiKey = process.env.AIRTABLE_VITALS_API_KEY || process.env.AIRTABLE_API_KEY;

  // Must match the Airtable TABLE name exactly
  const tableName = process.env.AIRTABLE_VITALS_TABLE || 'Vitals';

  // Your decision: "Name" is the permanent human-friendly identifier
  const locationField = process.env.AIRTABLE_VITALS_LOCATION_FIELD || 'Name';

  return { baseId, apiKey, tableName, locationField };
}

async function fetchVitalsSnapshot(clientLocationId) {
  const { baseId, apiKey, tableName, locationField } = getAirtableConfig();

  // Filter by the configured location field (ex: Name)
  const filterByFormula = clientLocationId ? `{${locationField}} = '${String(clientLocationId).replace(/'/g, "\\'")}'` : undefined;

  const { records, endpoint } = await fetchAirtableRecords({ baseId, tableName, apiKey, filterByFormula });

  // Require the configured location field (ex: Name) to exist on returned records
  const requiredFields = [locationField];

  const data = records.map((record) => {
    enforceRequiredFields(record, requiredFields);
    return {
      id: record.id,
      ...record.fields,
    };
  });

  return {
    fetched_at: new Date().toISOString(),
    location_field: locationField,
    client_location_id: clientLocationId || null, // keep API param name stable even though it maps to "Name"
    endpoint,
    count: data.length,
    data,
  };
}

// Fetch Airtable schema (tables + fields) so we can confirm exact table/field names.
async function fetchVitalsSchema() {
  const { baseId, apiKey, tableName, locationField } = getAirtableConfig();

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
    configured: {
      table_name: tableName,
      location_field: locationField,
    },
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
