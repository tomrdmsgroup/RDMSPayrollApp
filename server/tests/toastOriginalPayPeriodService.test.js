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

function testBuildPayrollExportRowsGroupsByPayrollEmployeeIdBeforeGuid() {
  const detailRows = [
    {
      employee_id: 'GUID-ONE',
      toast_employee_id: 'GUID-ONE',
      export_employee_id: '148',
      employee_name: 'Luis Acosta',
      job_name: 'Busser',
      job_code: '6325',
      location_display_name: '900 North Point Suite J101',
      location_code: 'j101',
      regular_hours: 10,
      overtime_hours: 0,
      hourly_rate: 19.18,
      regular_pay: 191.8,
      overtime_pay: 0,
      total_pay: 191.8,
    },
    {
      employee_id: 'GUID-TWO',
      toast_employee_id: 'GUID-TWO',
      export_employee_id: '148',
      employee_name: 'Luis Acosta',
      job_name: 'Busser',
      job_code: '6325',
      location_display_name: '900 North Point Suite J101',
      location_code: 'j101',
      regular_hours: 12,
      overtime_hours: 0,
      hourly_rate: 19.18,
      regular_pay: 230.16,
      overtime_pay: 0,
      total_pay: 230.16,
    },
  ];

  const rows = __test.buildPayrollExportRows(detailRows, 'j101');
  assert.equal(rows.length, 1, 'rows should aggregate by payroll employee id before GUID');
  assert.equal(rows[0]['Employee ID'], '148');
  assert.equal(rows[0]['Regular Hours'], 22);
  assert.equal(rows[0]['Total Pay'], 421.96);
}

function testNormalizeAnalyticsLaborRowPrefersNestedJobFieldsOverObjectValue() {
  const normalized = __test.normalizeAnalyticsLaborRow(
    {
      employeeGuid: 'E-200',
      employeeExternalId: '200',
      employeeName: 'Casey Ward',
      job: {
        id: 'J-10',
        name: 'Expediter',
      },
      locationName: '900 North',
      regularHours: 5,
      regularPay: 90,
    },
    {
      location: '900 North',
      periodStart: '2026-03-01',
      periodEnd: '2026-03-07',
      fallbackLocationCode: 'J101',
    }
  );

  assert.equal(normalized.job_code, 'J-10');
  assert.equal(normalized.job_name, 'Expediter');
  assert.notEqual(normalized.job_name, '[object Object]');
}

function testNormalizeTimeEntryRowSupportsNestedPayrollAndLaborJobAliases() {
  const normalized = __test.normalizeTimeEntryRow(
    {
      employeeGuid: 'E-312',
      employee: {
        externalEmployeeId: '312',
      },
      laborJobName: 'Expo',
      laborJobId: 'J-EXPO',
      locationName: 'Barrio',
      regularHours: 7.5,
    },
    'Barrio',
    'L-1'
  );

  assert.equal(normalized.employee_id, 'E-312');
  assert.equal(normalized.external_employee_id, '312');
  assert.equal(normalized.job_name, 'Expo');
  assert.equal(normalized.job_code, 'J-EXPO');
}

function testTimeEntryRowsCanPreserveMultipleJobsForOneEmployee() {
  const employeeByKey = new Map([
    ['e-9', { employee_id: 'E-9', employee_name: 'Riley Fox', external_employee_id: '409' }],
  ]);
  const timeEntries = [
    {
      employeeGuid: 'E-9',
      jobName: 'Server',
      jobCode: 'S-1',
      locationName: 'Barrio',
      locationCode: 'L-1',
      regularHours: 6,
    },
    {
      employeeGuid: 'E-9',
      jobName: 'Bartender',
      jobCode: 'B-1',
      locationName: 'Barrio',
      locationCode: 'L-1',
      regularHours: 4,
    },
  ];

  const detail = __test.buildExportShapedRowsFromTimeEntries({
    timeEntryRows: timeEntries,
    employeeByKey,
    fallbackLocationName: 'Barrio',
    fallbackLocationCode: 'L-1',
    periodStart: '2026-03-01',
    periodEnd: '2026-03-07',
  });
  const rows = __test.buildPayrollExportRows(detail, 'L-1', { includeSourceAudit: true });
  assert.equal(rows.rows.length, 2, 'time entry row grain should keep per-job splits');
  const server = rows.rows.find((r) => r['Job Title'] === 'Server');
  const bartender = rows.rows.find((r) => r['Job Title'] === 'Bartender');
  assert.ok(server);
  assert.ok(bartender);
  assert.equal(rows.rowSourceAudit[0].field_sources.job_title.source, 'toast_standard_time_entries');
}

function testAppliesEmployeeGroupedAnalyticsTotalsAcrossTimeEntryJobSplits() {
  const detailRows = [
    {
      employee_id: 'E-7',
      external_employee_id: '507',
      employee_name: 'Devin Park',
      toast_employee_id: 'E-7',
      export_employee_id: '507',
      job_name: 'Cook',
      job_code: 'C-1',
      location_display_name: 'Barrio',
      location_code: 'L-1',
      regular_hours: 8,
      overtime_hours: 0,
      regular_pay: 0,
      overtime_pay: 0,
      total_pay: 0,
      declared_tips: 0,
      non_cash_tips: 0,
      __field_sources: {},
    },
    {
      employee_id: 'E-7',
      external_employee_id: '507',
      employee_name: 'Devin Park',
      toast_employee_id: 'E-7',
      export_employee_id: '507',
      job_name: 'Dish',
      job_code: 'D-1',
      location_display_name: 'Barrio',
      location_code: 'L-1',
      regular_hours: 2,
      overtime_hours: 0,
      regular_pay: 0,
      overtime_pay: 0,
      total_pay: 0,
      declared_tips: 0,
      non_cash_tips: 0,
      __field_sources: {},
    },
  ];

  const analyticsTotals = __test.buildEmployeeAnalyticsTotalsIndex([
    {
      employee_id: 'E-7',
      external_employee_id: '507',
      regular_hours: 10,
      overtime_hours: 0,
      regular_pay: 200,
      overtime_pay: 0,
      total_pay: 200,
      declared_tips: 40,
      non_cash_tips: 10,
    },
  ]);

  __test.applyAnalyticsTotalsToTimeEntryRows(detailRows, analyticsTotals);

  const rows = __test.buildPayrollExportRows(detailRows, 'L-1');
  assert.equal(rows.length, 2);
  const cookRow = rows.find((r) => r['Job Title'] === 'Cook');
  const dishRow = rows.find((r) => r['Job Title'] === 'Dish');
  assert.equal(cookRow['Regular Hours'], 8);
  assert.equal(dishRow['Regular Hours'], 2);
  assert.equal(cookRow['Regular Pay'], 160);
  assert.equal(dishRow['Regular Pay'], 40);
  assert.equal(cookRow['Total Pay'] + dishRow['Total Pay'], 200);
}

module.exports = {
  testNormalizeEmployeeIdentityUsesFallbackMappings,
  testJoinAndBuildPayrollExportRowsAggregatesToEmployeeJobLocationGrain,
  testJoinLaborRowsUsesTimeEntryFallbackForJobAndLocation,
  testBuildPayrollExportRowsGroupsByPayrollEmployeeIdBeforeGuid,
  testNormalizeAnalyticsLaborRowPrefersNestedJobFieldsOverObjectValue,
  testNormalizeTimeEntryRowSupportsNestedPayrollAndLaborJobAliases,
  testTimeEntryRowsCanPreserveMultipleJobsForOneEmployee,
  testAppliesEmployeeGroupedAnalyticsTotalsAcrossTimeEntryJobSplits,
};
