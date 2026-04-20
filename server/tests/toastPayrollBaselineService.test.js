const assert = require('assert');
const {
  parseCsv,
  normalizeUploadedRow,
  normalizeApiRow,
  buildStableKey,
  compareRows,
} = require('../src/domain/toastPayrollBaselineService');

function testParseCsvHandlesQuotedFields() {
  const csv = 'Toast Employee ID,Employee,Job Title,Total Pay\n"E-1","Able, Alex","Server",120.50\n';
  const parsed = parseCsv(csv);
  assert.equal(parsed.headers.length, 4);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].Employee, 'Able, Alex');
}

function testCompareRowsDetectsMissingAndMismatches() {
  const context = { location_name: 'Barrio', period_start: '2026-04-01', period_end: '2026-04-14' };
  const api = [
    normalizeApiRow(
      {
        'Toast Employee ID': 'E-1',
        'Employee ID': 'P-1',
        Employee: 'Alex Able',
        'Job Title': 'Server',
        Location: 'Barrio',
        'Regular Hours': 10,
        'Overtime Hours': 0,
        'Total Pay': 200,
      },
      context,
    ),
  ];

  const uploaded = [
    normalizeUploadedRow(
      {
        'Toast Employee ID': 'E-1',
        'Employee ID': 'P-1',
        Employee: 'Alex Able',
        'Job Title': 'Server',
        Location: 'Barrio',
        'Regular Hours': '10',
        'Overtime Hours': '0',
        'Total Pay': '210',
      },
      context,
    ),
    normalizeUploadedRow(
      {
        'Toast Employee ID': 'E-9',
        Employee: 'Casey',
        'Job Title': 'Bartender',
        Location: 'Barrio',
      },
      context,
    ),
  ];

  api.forEach((r) => (r.stable_key = buildStableKey(r)));
  uploaded.forEach((r) => (r.stable_key = buildStableKey(r)));
  const result = compareRows(api, uploaded);

  assert.equal(result.summary.api_row_count, 1);
  assert.equal(result.summary.csv_row_count, 2);
  assert.equal(result.summary.missing_in_api_count, 1);
  assert.equal(result.summary.missing_in_csv_count, 0);
  assert.equal(result.summary.mismatch_count, 1);
  assert.equal(result.column_mismatches[0].diffs[0].field, 'total_pay');
}

module.exports = {
  testParseCsvHandlesQuotedFields,
  testCompareRowsDetectsMissingAndMismatches,
};
