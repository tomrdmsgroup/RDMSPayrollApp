const DEFAULT_AIRTABLE_URL = 'https://api.airtable.com/v0';

async function fetchAirtableRecords({ baseId, tableName, apiKey, filterByFormula }) {
  if (!baseId) {
    throw new Error('airtable_base_required');
  }
  if (!tableName) {
    throw new Error('airtable_table_required');
  }
  if (!apiKey) {
    throw new Error('airtable_api_key_required');
  }

  const url = new URL(`${DEFAULT_AIRTABLE_URL}/${baseId}/${encodeURIComponent(tableName)}`);
  if (filterByFormula) {
    url.searchParams.set('filterByFormula', filterByFormula);
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const body = await safeParseJson(response);
    const message = body?.error?.message || body?.error || `airtable_error_${response.status}`;
    throw new Error(message);
  }

  const json = await response.json();
  const records = Array.isArray(json?.records) ? json.records : [];

  return { records, endpoint: url.toString() };
}

async function safeParseJson(response) {
  try {
    return await response.json();
  } catch (e) {
    return null;
  }
}

function enforceRequiredFields(record, requiredFields) {
  const missing = requiredFields.filter((field) => {
    const value = record?.fields?.[field];
    return value === undefined || value === null || value === '';
  });

  if (missing.length > 0) {
    throw new Error(`airtable_missing_fields:${missing.join(',')}`);
  }
}

module.exports = { fetchAirtableRecords, enforceRequiredFields };
