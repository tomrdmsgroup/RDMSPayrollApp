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

function testJoinAndBuildPayrollExportRowsAggregatesToEmployeeJobLocationGrain() {
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
  assert.equal(rows.length, 2, 'must aggregate to employee + job + location row grain');

  const serverRow = rows.find((r) => r['Job Title'] === 'Server' && r.Location === 'Barrio');
  const bartenderRow = rows.find((r) => r['Job Title'] === 'Bartender');
  assert.ok(serverRow);
  assert.ok(bartenderRow);
  assert.equal(serverRow['Toast Employee ID'], 'E-1');
  assert.equal(serverRow.Employee, 'Alex Able');
  assert.equal(serverRow['Employee ID'], 'PAY-1');
  assert.equal(serverRow['Job Code'], 'JC-1');
  assert.equal(serverRow['Regular Hours'], 6);
  assert.equal(serverRow['Overtime Hours'], 1);
  assert.equal(serverRow['Regular Pay'], 75);
  assert.equal(serverRow['Overtime Pay'], 18.75);
  assert.equal(serverRow['Total Pay'], 93.75);
  assert.equal(serverRow['Declared Tips'], 15);
  assert.equal(serverRow['Non-Cash Tips'], 5);
  assert.equal(serverRow['Total Tips'], 20);
  assert.equal(serverRow.Location, 'Barrio');
  assert.equal(serverRow['Location Code'], 'L1');
}

function testJoinLaborRowsUsesTimeEntryFallbackForJobAndLocation() {
  const employeeByKey = new Map();
  const timeEntryByKey = new Map([
    [
      'e-55',
      {
        employee_id: 'E-55',
        external_employee_id: '155',
        employee_name: 'Jordan Lane',
        top_job_name: 'Line Cook',
        top_job_code: '6125',
        top_location_name: '900 North',
        top_location_code: 'j101',
      },
    ],
  ]);

  const analyticsRows = [
    {
      employee_id: 'E-55',
      employee_name: null,
      job_code: null,
      job_name: null,
      location_name: 'Barrio',
      location_display_name: 'Barrio',
      location_code: null,
      regular_hours: 8,
      overtime_hours: 0,
      regular_pay: 160,
      overtime_pay: 0,
      total_pay: 160,
    },
  ];

  const joined = __test.joinLaborRowsToEmployees(analyticsRows, employeeByKey, timeEntryByKey);
  assert.equal(joined[0].job_name, 'Line Cook');
  assert.equal(joined[0].location_display_name, 'Barrio', 'analytics location remains preferred when present');
  assert.equal(joined[0].location_code, 'j101');
  assert.equal(joined[0].export_employee_id, '155');
}

module.exports = {
  testNormalizeEmployeeIdentityUsesFallbackMappings,
  testJoinAndBuildPayrollExportRowsAggregatesToEmployeeJobLocationGrain,
  testJoinLaborRowsUsesTimeEntryFallbackForJobAndLocation,
};
