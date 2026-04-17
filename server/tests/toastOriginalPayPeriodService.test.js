const assert = require('assert');
const { __test } = require('../src/domain/toastOriginalPayPeriodService');

function testNormalizeTimeEntryUsesFallbackMappings() {
  const raw = {
    employee: { externalEmployeeId: 'EMP-42', firstName: 'Ari', lastName: 'Ng' },
    job: { code: 'SRV-1', title: 'Server' },
    location: { externalId: 'LOC-9', displayName: 'Barrio Downtown' },
    regularHours: 6,
    overtimeHours: 1,
  };

  const row = __test.normalizeTimeEntry(raw, {
    location: 'Barrio',
    periodStart: '2026-03-30',
    periodEnd: '2026-04-12',
  });

  assert.equal(row.employee_id, 'EMP-42');
  assert.equal(row.employee_name, 'Ari Ng');
  assert.equal(row.job_code, 'SRV-1');
  assert.equal(row.job_name, 'Server');
  assert.equal(row.location_code, 'LOC-9');
  assert.equal(row.location_display_name, 'Barrio Downtown');
}

function testBuildPayrollExportRowsGroupsByEmployeeAndJobTitle() {
  const detailRows = [
    {
      employee_id: 'E-1',
      employee_name: 'Alex Able',
      job_code: 'JC-1',
      job_name: 'Server',
      location_name: 'Barrio',
      location_display_name: 'Barrio',
      location_code: 'L1',
      regular_hours: 4,
      overtime_hours: 0,
      regular_pay: 50,
      overtime_pay: 0,
      total_pay: 50,
      declared_tips: 10,
      non_cash_tips: 5,
      source_time_entry_id: 't1',
    },
    {
      employee_id: 'E-1',
      employee_name: 'Alex Able',
      job_code: 'JC-1',
      job_name: 'Server',
      location_name: 'Barrio',
      location_display_name: 'Barrio',
      location_code: 'L1',
      regular_hours: 2,
      overtime_hours: 1,
      regular_pay: 25,
      overtime_pay: 18.75,
      total_pay: 43.75,
      declared_tips: 5,
      non_cash_tips: 0,
      source_time_entry_id: 't2',
    },
    {
      employee_id: 'E-1',
      employee_name: 'Alex Able',
      job_code: 'JC-2',
      job_name: 'Bartender',
      location_name: 'Barrio',
      location_display_name: 'Barrio',
      location_code: 'L1',
      regular_hours: 3,
      overtime_hours: 0,
      regular_pay: 40,
      overtime_pay: 0,
      total_pay: 40,
      declared_tips: 0,
      non_cash_tips: 8,
      source_time_entry_id: 't3',
    },
  ];

  const rows = __test.buildPayrollExportRows(detailRows, 'L1');
  assert.equal(rows.length, 2, 'must produce one row per employee + job title');

  const serverRow = rows.find((r) => r['Job Title'] === 'Server');
  const bartenderRow = rows.find((r) => r['Job Title'] === 'Bartender');
  assert.ok(serverRow);
  assert.ok(bartenderRow);
  assert.equal(serverRow.Employee, 'Alex Able');
  assert.equal(serverRow['Employee ID'], 'E-1');
  assert.equal(serverRow['Job Code'], 'JC-1');
  assert.equal(serverRow.Location, 'Barrio');
  assert.equal(serverRow['Location Code'], 'L1');
}

module.exports = {
  testNormalizeTimeEntryUsesFallbackMappings,
  testBuildPayrollExportRowsGroupsByEmployeeAndJobTitle,
};
