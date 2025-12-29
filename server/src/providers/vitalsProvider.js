// server/src/providers/vitalsProvider.js

const { fetchAirtableRecords } = require('./airtableClient');

const DEFAULT_AIRTABLE_META_URL = 'https://api.airtable.com/v0/meta';

function getAirtableConfig() {
  const baseId = process.env.AIRTABLE_VITALS_BASE;
  const apiKey = process.env.AIRTABLE_VITALS_API_KEY || process.env.AIRTABLE_API_KEY;
  const tableName = process.env.AIRTABLE_VITALS_TABLE || 'Vitals';
  const locationField = process.env.AIRTABLE_VITALS_LOCATION_FIELD || 'Name';

  return { baseId, apiKey, tableName, locationField };
}

function getLocationValue(record, locationField) {
  if (record.fields && record.fields[locationField] !== undefined && record.fields[locationField] !== null) {
    return record.fields[locationField];
  }
  if (locationField === 'Name' && record.name) {
    return record.name;
  }
  return null;
}

async function fetchVitalsSnapshot(clientLocationId) {
  const { baseId, apiKey, tableName, locationField } = getAirtableConfig();

  const filterByFormula = clientLocationId
    ? `{${locationField}} = '${String(clientLocationId).replace(/'/g, "\\'")}'`
    : undefined;

  const { records, endpoint } = await fetchAirtableRecords({
    baseId,
    tableName,
    apiKey,
    filterByFormula,
  });

  const data = [];
  const skippedIds = [];

  for (const record of records) {
    const locationValue = getLocationValue(record, locationField);

    // If the caller asked for a specific location, missing identifier is a real error.
    if (clientLocationId) {
      if (!locationValue) throw new Error(`airtable_missing_fields:${locationField}`);
      data.push({ id: record.id, [locationField]: locationValue, ...record.fields });
      continue;
    }

    // Unfiltered: skip invalid rows so the endpoint is robust.
    if (!locationValue) {
      skippedIds.push(record.id);
      continue;
    }

    data.push({ id: record.id, [locationField]: locationValue, ...record.fields });
  }

  return {
    fetched_at: new Date().toISOString(),
    location_field: locationField,
    client_location_id: clientLocationId || null,
    endpoint,
    count: data.length,
    skipped: skippedIds.length,
    skipped_ids: skippedIds.slice(0, 25), // cap to avoid giant responses
    data,
  };
}

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
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message || `airtable_meta_error_${response.status}`);
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
  };
}

module.exports = { fetchVitalsSnapshot, fetchVitalsSchema };
