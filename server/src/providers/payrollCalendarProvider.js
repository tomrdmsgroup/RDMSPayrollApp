const { fetchAirtableRecords, enforceRequiredFields } = require('./airtableClient');

async function fetchPeriods(clientLocationId) {
  const baseId = process.env.AIRTABLE_PAYROLL_CALENDAR_BASE;
  const apiKey = process.env.AIRTABLE_PAYROLL_CALENDAR_API_KEY || process.env.AIRTABLE_API_KEY;
  const tableName = process.env.AIRTABLE_PAYROLL_CALENDAR_TABLE || 'Payroll Calendar';

  const filterByFormula = clientLocationId ? `{client_location_id} = '${clientLocationId}'` : undefined;
  const { records, endpoint } = await fetchAirtableRecords({ baseId, tableName, apiKey, filterByFormula });

  const requiredFields = ['period_start', 'period_end', 'validation_date'];

  return records.map((record) => {
    enforceRequiredFields(record, requiredFields);
    return {
      id: record.id,
      endpoint,
      client_location_id: record.fields.client_location_id,
      period_start: record.fields.period_start,
      period_end: record.fields.period_end,
      validation_date: record.fields.validation_date,
      cutoff_date: record.fields.cutoff_date,
    };
  });
}

module.exports = { fetchPeriods };
