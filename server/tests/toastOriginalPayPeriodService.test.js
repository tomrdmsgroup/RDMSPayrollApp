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

  assert.equal(row.employee_id, 'PAY-42');
  assert.equal(row.employee_name, 'Ari Ng');
  assert.equal(row.external_employee_id, 'PAY-42');
}

function testGroupingUsesToastGuidNotPayrollEmployeeId() {
  const detailRows = [
    {
      toast_employee_id: 'GUID-ONE',
      export_employee_id: '148',
      employee_name: 'Luis Acosta',
      job_name: 'Busser',
      job_code: '6325',
      hourly_rate: 19.18,
      regular_hours: 10,
      overtime_hours: 0,
      __field_sources: {},
    },
    {
      toast_employee_id: 'GUID-TWO',
      export_employee_id: '148',
      employee_name: 'Luis Acosta',
      job_name: 'Busser',
      job_code: '6325',
      hourly_rate: 19.18,
      regular_hours: 12,
      overtime_hours: 0,
      __field_sources: {},
    },
  ];

  const rows = __test.buildPayrollExportRows(detailRows);
  assert.equal(rows.length, 2, 'same payroll ID must not merge two different toast GUIDs');
}

function testGroupingSplitsSameEmployeeAndDepartmentAcrossRates() {
  const employeeByKey = new Map([
    ['guid-1', { employee_id: 'GUID-1', external_employee_id: 'P1', toast_employee_id: 'GUID-1', employee_name: 'Alex' }],
  ]);

  const rows = __test.buildExportShapedRowsFromTimeEntries({
    timeEntryRows: [
      { employeeGuid: 'GUID-1', jobCode: 'J-1', jobName: 'Server', hourlyRate: 18, regularHours: 5 },
      { employeeGuid: 'GUID-1', jobCode: 'J-1', jobName: 'Server', hourlyRate: 18.5, regularHours: 4 },
    ],
    employeeByKey,
    fallbackLocationName: 'Barrio',
    fallbackLocationCode: 'L1',
    periodStart: '2026-03-30',
    periodEnd: '2026-04-12',
  });

  const exportRows = __test.buildPayrollExportRows(rows);
  assert.equal(exportRows.length, 2);
  assert.deepEqual(
    exportRows.map((r) => r.Rate).sort((a, b) => a - b),
    [18, 18.5]
  );
}

function testGroupingSplitsSameEmployeeAcrossDepartments() {
  const employeeByKey = new Map([
    ['guid-9', { employee_id: 'GUID-9', external_employee_id: '409', toast_employee_id: 'GUID-9', employee_name: 'Riley Fox' }],
  ]);

  const rows = __test.buildExportShapedRowsFromTimeEntries({
    timeEntryRows: [
      { employeeGuid: 'GUID-9', jobName: 'Server', jobCode: 'S-1', hourlyRate: 20, regularHours: 6 },
      { employeeGuid: 'GUID-9', jobName: 'Bartender', jobCode: 'B-1', hourlyRate: 20, regularHours: 4 },
    ],
    employeeByKey,
    fallbackLocationName: 'Barrio',
    fallbackLocationCode: 'L1',
    periodStart: '2026-03-30',
    periodEnd: '2026-04-12',
  });

  const exportRows = __test.buildPayrollExportRows(rows);
  assert.equal(exportRows.length, 2);
}

function testOutputContainsOnlyHoursColumnsForToastOriginalRows() {
  const rows = __test.buildPayrollExportRows([
    {
      toast_employee_id: 'GUID-1',
      export_employee_id: '101',
      employee_name: 'A',
      job_name: 'Server',
      job_code: 'S-1',
      hourly_rate: 18,
      regular_hours: 4,
      overtime_hours: 1,
      __field_sources: {},
    },
  ]);

  const keys = Object.keys(rows[0]).sort();
  assert.deepEqual(keys, ['Department / Job', 'Employee', 'Employee ID', 'Overtime Hours', 'Rate', 'Regular Hours', 'Total Hours']);
  assert.equal('Toast Employee ID' in rows[0], false);
  assert.equal('Location' in rows[0], false);
  assert.equal('Location Code' in rows[0], false);
  assert.equal('Regular Pay' in rows[0], false);
  assert.equal('Overtime Pay' in rows[0], false);
  assert.equal('Total Pay' in rows[0], false);
  assert.equal('Net Sales' in rows[0], false);
  assert.equal('Declared Tips' in rows[0], false);
  assert.equal('Non-Cash Tips' in rows[0], false);
  assert.equal('Total Tips' in rows[0], false);
  assert.equal('Tips Withheld' in rows[0], false);
  assert.equal('Total Gratuity' in rows[0], false);
}

module.exports = {
  testNormalizeEmployeeIdentityUsesFallbackMappings,
  testGroupingUsesToastGuidNotPayrollEmployeeId,
  testGroupingSplitsSameEmployeeAndDepartmentAcrossRates,
  testGroupingSplitsSameEmployeeAcrossDepartments,
  testOutputContainsOnlyHoursColumnsForToastOriginalRows,
};
