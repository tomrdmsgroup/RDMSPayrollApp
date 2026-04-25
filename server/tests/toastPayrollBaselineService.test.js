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

function testNormalizeUploadedRowIncludesJobCodeAndHourlyRateFromCsv() {
  const context = { location_name: 'Barrio', period_start: '2026-04-01', period_end: '2026-04-14' };
  const normalized = normalizeUploadedRow(
    {
      Employee: 'Acosta, Luis Carlos',
      'Employee ID': '148',
      'Job Title': 'Busser',
      'Job Code': 'BUS100',
      'Hourly Rate': '28.669999999999998',
      'Regular Hours': '10.5',
      'Overtime Hours': '1.53',
    },
    context,
  );

  assert.equal(normalized.job_code, 'BUS100');
  assert.equal(normalized.hourly_rate, 28.669999999999998);
  assert.equal(normalized.regular_hours, 10.5);
  assert.equal(normalized.overtime_hours, 1.53);
}

function testBuildStableKeyPrefersEmployeeIdOverToastGuid() {
  const row = {
    location_name: 'Barrio',
    pay_period_start: '2026-04-01',
    pay_period_end: '2026-04-14',
    toast_employee_id: '8f0f7d62-3f11-4db2-9ec0-78ed16f30abc',
    employee_id: '148',
    employee_name: 'Acosta, Lu',
    job_title: 'Busser',
    location: '900 North',
    location_code: 'j101',
  };

  const key = buildStableKey(row);
  assert.ok(key.startsWith('148|||'), `expected stable key to start with numeric employee_id, got: ${key}`);
}

function testBuildStableKeyFallsBackToEmployeeNameBeforeToastGuid() {
  const row = {
    location_name: 'Barrio',
    pay_period_start: '2026-04-01',
    pay_period_end: '2026-04-14',
    toast_employee_id: '8f0f7d62-3f11-4db2-9ec0-78ed16f30abc',
    employee_id: null,
    employee_name: 'Acosta, Lu',
    job_title: 'Busser',
    location: '900 North',
    location_code: 'j101',
  };

  const key = buildStableKey(row);
  assert.ok(
    key.startsWith('acosta, lu|||'),
    `expected stable key to fall back to employee_name before toast guid, got: ${key}`
  );
}

module.exports = {
  testParseCsvHandlesQuotedFields,
  testCompareRowsDetectsMissingAndMismatches,
  testBuildStableKeyPrefersEmployeeIdOverToastGuid,
  testBuildStableKeyFallsBackToEmployeeNameBeforeToastGuid,
  testNormalizeUploadedRowIncludesJobCodeAndHourlyRateFromCsv,
};
