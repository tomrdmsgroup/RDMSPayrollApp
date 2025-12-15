const { fetchAirtableRecords, enforceRequiredFields } = require('./airtableClient');

async function fetchVitalsSnapshot(clientLocationId) {
  const baseId = process.env.AIRTABLE_VITALS_BASE;
  const apiKey = process.env.AIRTABLE_VITALS_API_KEY || process.env.AIRTABLE_API_KEY;
  const tableName = process.env.AIRTABLE_VITALS_TABLE || 'Vitals';

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

module.exports = { fetchVitalsSnapshot };
