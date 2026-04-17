const assert = require('assert');
const { __test } = require('../src/domain/toastOriginalPayPeriodService');

function testNormalizeEmployeeIdentityUsesFallbackMappings() {
  const raw = {
    id: 'EMP-42',
    firstName: 'Ari',
    lastName: 'Ng',
    externalEmployeeId: 'PAY-42',
  };

  const row = __test.normalizeEmployeeIdentity(raw);

  assert.equal(row.employee_id, 'EMP-42');
  assert.equal(row.employee_name, 'Ari Ng');
  assert.equal(row.external_employee_id, 'PAY-42');
}

function testJoinAndBuildPayrollExportRowsKeepsFinerRowGrain() {
  const employeeByKey = new Map([
    ['e-1', { employee_id: 'E-1', employee_name: 'Alex Able', external_employee_id: 'PAY-1' }],
  ]);

  const analyticsRows = [
    {
      employee_id: 'E-1',
      employee_name: null,
      job_code: 'JC-1',
      job_name: 'Server',
      location_name: 'Barrio',
      location_display_name: 'Barrio',
      location_code: 'L1',
      business_date: '2026-03-31',
      pay_type: 'Regular',
      regular_hours: 4,
      overtime_hours: 0,
      regular_pay: 50,
      overtime_pay: 0,
      total_pay: 50,
      declared_tips: 10,
      non_cash_tips: 5,
    },
    {
      employee_id: 'E-1',
      employee_name: null,
      job_code: 'JC-1',
      job_name: 'Server',
      location_name: 'Barrio',
      location_display_name: 'Barrio',
      location_code: 'L1',
      business_date: '2026-04-01',
      pay_type: 'Overtime',
      regular_hours: 2,
      overtime_hours: 1,
      regular_pay: 25,
      overtime_pay: 18.75,
      total_pay: 43.75,
      declared_tips: 5,
      non_cash_tips: 0,
    },
    {
      employee_id: 'E-1',
      employee_name: null,
      job_code: 'JC-2',
      job_name: 'Bartender',
      location_name: 'Barrio',
      location_display_name: 'Barrio',
      location_code: 'L1',
      business_date: '2026-04-02',
      pay_type: 'Regular',
      regular_hours: 3,
      overtime_hours: 0,
      regular_pay: 40,
      overtime_pay: 0,
      total_pay: 40,
      declared_tips: 0,
      non_cash_tips: 8,
    },
  ];

  const joined = __test.joinLaborRowsToEmployees(analyticsRows, employeeByKey);
  const rows = __test.buildPayrollExportRows(joined, 'L1');
  assert.equal(rows.length, 3, 'must preserve row grain beyond employee + job title');

  const serverRow = rows.find((r) => r['Job Title'] === 'Server');
  const bartenderRow = rows.find((r) => r['Job Title'] === 'Bartender');
  assert.ok(serverRow);
  assert.ok(bartenderRow);
  assert.equal(serverRow['Toast Employee ID'], 'E-1');
  assert.equal(serverRow.Employee, 'Alex Able');
  assert.equal(serverRow['Employee ID'], 'PAY-1');
  assert.equal(serverRow['Job Code'], 'JC-1');
  assert.equal(serverRow['Business Date'], '2026-03-31');
  assert.equal(serverRow['Pay Type'], 'Regular');
  assert.equal(serverRow.Location, 'Barrio');
  assert.equal(serverRow['Location Code'], 'L1');
}

module.exports = {
  testNormalizeEmployeeIdentityUsesFallbackMappings,
  testJoinAndBuildPayrollExportRowsKeepsFinerRowGrain,
};
