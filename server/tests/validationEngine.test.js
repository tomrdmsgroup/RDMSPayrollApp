const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runValidation, __test } = require('../src/domain/validationEngine');

async function testRunValidationFindsNewEmpRateDept() {
  const selectedKey = '2026-03-01__2026-03-14';
  const prior1Key = '2026-02-15__2026-02-28';

  const result = await runValidation({
    run: {
      id: 101,
      client_location_id: 'Test Location',
      period_start: '2026-03-01',
      period_end: '2026-03-14',
    },
    context: {
      active_rule_ids: ['NEWEMP', 'NEWRATE', 'NEWDEPT'],
      comparison_periods: [{ period_start: '2026-02-15', period_end: '2026-02-28' }],
      toast_rows_by_period: {
        [selectedKey]: [
          {
            employeeGuid: 'E1',
            employeeName: 'Alex Able',
            jobName: 'Server',
            hourlyRate: 20,
          },
          {
            employeeGuid: 'E2',
            employeeName: 'Bri Baker',
            jobName: 'Bar',
            hourlyRate: 20,
          },
        ],
        [prior1Key]: [
          {
            employeeGuid: 'E1',
            employeeName: 'Alex Able',
            jobName: 'Host',
            hourlyRate: 20,
          },
        ],
      },
    },
    exclusions: [],
  });

  const findings = result.findings;
  assert.equal(findings.length, 5, 'should emit 5 findings across NEWEMP/NEWDEPT/NEWRATE for both employees');

  const ids = findings.map((f) => `${f.rule_id}:${f.toast_employee_id}`);
  assert.ok(ids.includes('NEWEMP:E2'));
  assert.ok(ids.includes('NEWDEPT:E1'));
  assert.ok(ids.includes('NEWRATE:E1'));
  assert.ok(ids.includes('NEWRATE:E2'));
  assert.ok(ids.includes('NEWDEPT:E2'));
}

async function testRunValidationHonorsExclusionsAndActiveRules() {
  const result = await runValidation({
    run: {
      id: 102,
      client_location_id: 'Test Location',
      period_start: '2026-03-01',
      period_end: '2026-03-14',
    },
    context: {
      active_rule_ids: ['NEWEMP'],
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-03-01__2026-03-14': [
          { employeeGuid: 'EX1', employeeName: 'Excluded Person', jobName: 'Server', hourlyRate: 20 },
          { employeeGuid: 'A1', employeeName: 'Active Person', jobName: 'Server', hourlyRate: 20 },
        ],
      },
    },
    exclusions: [
      {
        toast_employee_id: 'EX1',
        active: true,
        effective_from: '2026-01-01',
        effective_to: '2026-12-31',
      },
    ],
  });

  assert.equal(result.findings.length, 1, 'only one non-excluded NEWEMP should be emitted');
  assert.equal(result.findings[0].toast_employee_id, 'A1');
  assert.equal(result.findings[0].rule_id, 'NEWEMP');
}

function testValidationEngineDoesNotImportAnalyticsProvider() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'validationEngine.js'), 'utf8');
  assert.equal(source.includes('fetchToastAnalyticsJobsFromVitals'), false);
}

function testValidationEngineDoesNotCallEraLaborEndpoint() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'domain', 'validationEngine.js'), 'utf8');
  assert.equal(source.includes('/era/v1/labor'), false);
}

async function testFetchToastRowsForPeriodsUsesStandardOnlyAndLoadsSelectedAndPrior() {
  const calls = {
    vitals: 0,
    employees: 0,
    jobs: 0,
    timeEntries: [],
  };

  const result = await __test.fetchToastRowsForPeriods({
    clientLocationId: 'Test Location',
    periods: [
      { period_start: '2026-03-01', period_end: '2026-03-14' },
      { period_start: '2026-02-15', period_end: '2026-02-28' },
    ],
    deps: {
      fetchVitalsSnapshot: async () => {
        calls.vitals += 1;
        return { data: [{}] };
      },
      fetchToastEmployeesFromVitals: async () => {
        calls.employees += 1;
        return {
          ok: true,
          data: [{ guid: 'E1', firstName: 'Alex', lastName: 'Able', externalEmployeeId: 'PAY-1' }],
        };
      },
      fetchToastJobsFromVitals: async () => {
        calls.jobs += 1;
        return {
          ok: true,
          data: [{ guid: 'J1', title: 'Server', code: 'S-1' }],
        };
      },
      fetchToastTimeEntriesFromVitals: async ({ periodStart, periodEnd }) => {
        calls.timeEntries.push(`${periodStart}__${periodEnd}`);
        return {
          ok: true,
          data: [
            {
              employeeReference: { guid: 'E1' },
              jobReference: { guid: 'J1' },
              hourlyWage: 22.5,
              regularHours: 8,
              overtimeHours: 1,
              businessDate: '2026-03-02',
            },
          ],
        };
      },
    },
  });

  assert.equal(calls.vitals, 1);
  assert.equal(calls.employees, 1);
  assert.equal(calls.jobs, 1);
  assert.deepEqual(calls.timeEntries, ['2026-03-01__2026-03-14', '2026-02-15__2026-02-28']);
  assert.equal(Object.keys(result.rowsByPeriod).length, 2);
  assert.equal(result.sourceMeta.length, 2);
  assert.equal(result.sourceMeta[0].source, 'toast_standard_labor');
  assert.deepEqual(result.sourceMeta[0].endpoints, ['/labor/v1/timeEntries', '/labor/v1/employees', '/labor/v1/jobs']);
}

function testStandardJoinNormalizesEmployeeJobAndRateFields() {
  const rows = __test.normalizeStandardValidationRows({
    timeEntryRows: [
      {
        employeeReference: { guid: 'emp-1' },
        jobReference: { guid: 'job-1' },
        hourlyWage: 18.5,
        regularHours: 6,
        overtimeHours: 2,
        businessDate: '2026-03-11',
        inDate: '2026-03-11T09:00:00.000Z',
        outDate: '2026-03-11T17:00:00.000Z',
      },
    ],
    employeeRows: [{ guid: 'emp-1', firstName: 'Alex', lastName: 'Able', externalEmployeeId: 'P-100' }],
    jobRows: [{ guid: 'job-1', title: 'Server', code: 'S-1', defaultWage: 25 }],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].employeeGuid, 'emp-1');
  assert.equal(rows[0].toast_employee_id, 'emp-1');
  assert.equal(rows[0].employeeName, 'Able, Alex');
  assert.equal(rows[0].externalEmployeeId, 'P-100');
  assert.equal(rows[0].jobGuid, 'job-1');
  assert.equal(rows[0].jobTitle, 'Server');
  assert.equal(rows[0].departmentName, 'Server');
  assert.equal(rows[0].jobCode, 'S-1');
  assert.equal(rows[0].hourlyRate, 18.5);
  assert.equal(rows[0].payRate, 18.5);
  assert.equal(rows[0].rate, 18.5);
}


async function testRunValidationMissingIdRule() {
  const result = await runValidation({
    run: {
      id: 103,
      client_location_id: 'Test Location',
      period_start: '2026-03-01',
      period_end: '2026-03-14',
    },
    context: {
      active_rule_ids: ['MISSINGID'],
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-03-01__2026-03-14': [
          { employeeGuid: 'M1', employeeName: 'Miss One', payrollFileId: '   ' },
          { employeeGuid: 'M1', employeeName: 'Miss One', payrollFileId: null },
          { employeeGuid: 'M2', employeeName: 'Has Id', payrollFileId: 'PF-2' },
          { employeeGuid: 'MX', employeeName: 'Excluded Id', payrollFileId: '' },
        ],
      },
    },
    exclusions: [{ toast_employee_id: 'MX', active: true, effective_from: '2026-01-01', effective_to: '2026-12-31' }],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].rule_id, 'MISSINGID');
  assert.equal(result.findings[0].toast_employee_id, 'M1');
}

async function testRunValidationMissingIdInactiveDoesNotEmit() {
  const result = await runValidation({
    run: { id: 104, client_location_id: 'Test Location', period_start: '2026-03-01', period_end: '2026-03-14' },
    context: {
      active_rule_ids: ['NEWEMP'],
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-03-01__2026-03-14': [{ employeeGuid: 'M1', employeeName: 'Miss One', payrollFileId: '' }],
      },
    },
    exclusions: [],
  });

  assert.equal(result.findings.some((f) => f.rule_id === 'MISSINGID'), false);
}

async function testRunValidationOtThresholdRule() {
  const ruleCatalog = [
    { rule_id: 'OTTHRESHOLD', rule_name: 'OT over X Hours', params: JSON.stringify({ threshold: 5 }) },
  ];

  const result = await runValidation({
    run: { id: 105, client_location_id: 'Test Location', period_start: '2026-03-01', period_end: '2026-03-14' },
    context: {
      active_rule_ids: ['OTTHRESHOLD'],
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-03-01__2026-03-14': [
          { employeeGuid: 'O1', employeeName: 'Over One', overtimeHours: 3 },
          { employeeGuid: 'O1', employeeName: 'Over One', overtimeHours: 3 },
          { employeeGuid: 'O2', employeeName: 'Equal Two', overtimeHours: 5 },
          { employeeGuid: 'OX', employeeName: 'Excluded OT', overtimeHours: 6 },
        ],
      },
    },
    exclusions: [{ toast_employee_id: 'OX', active: true, effective_from: '2026-01-01', effective_to: '2026-12-31' }],
    ruleCatalog,
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].rule_id, 'OTTHRESHOLD');
  assert.equal(result.findings[0].toast_employee_id, 'O1');
  assert.equal(result.findings[0].detail.includes('6'), true);
}

async function testRunValidationOtThresholdInvalidConfigSkips() {
  const result = await runValidation({
    run: { id: 106, client_location_id: 'Test Location', period_start: '2026-03-01', period_end: '2026-03-14' },
    context: {
      active_rule_ids: ['OTTHRESHOLD'],
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-03-01__2026-03-14': [{ employeeGuid: 'O1', employeeName: 'Over One', overtimeHours: 8 }],
      },
    },
    exclusions: [],
    ruleCatalog: [{ rule_id: 'OTTHRESHOLD', params: 'not-json' }],
  });

  assert.equal(result.findings.length, 0);
}

async function testRunValidationMinWageRule() {
  const result = await runValidation({
    run: { id: 107, client_location_id: 'Test Location', period_start: '2026-03-01', period_end: '2026-03-14' },
    context: {
      active_rule_ids: ['MINWAGE'],
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-03-01__2026-03-14': [
          { employeeGuid: 'W1', employeeName: 'Wage One', jobName: 'Server', regularHours: 4, regularCost: 40 },
          { employeeGuid: 'W1', employeeName: 'Wage One', jobName: 'Server', payRate: 10 },
          { employeeGuid: 'W2', employeeName: 'Wage Two', jobName: 'Bar', rate: 12 },
          { employeeGuid: 'WX', employeeName: 'Excluded Wage', jobName: 'Host', hourlyRate: 8 },
        ],
      },
    },
    exclusions: [{ toast_employee_id: 'WX', active: true, effective_from: '2026-01-01', effective_to: '2026-12-31' }],
    ruleCatalog: [{ rule_id: 'MINWAGE', rule_name: 'Under Minimum Wage', params: { minimumWage: 11 } }],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].rule_id, 'MINWAGE');
  assert.equal(result.findings[0].toast_employee_id, 'W1');
  assert.equal(result.findings[0].detail.includes('10.00'), true);
}

async function testRunValidationMinWageInvalidConfigSkips() {
  const result = await runValidation({
    run: { id: 108, client_location_id: 'Test Location', period_start: '2026-03-01', period_end: '2026-03-14' },
    context: {
      active_rule_ids: ['MINWAGE'],
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-03-01__2026-03-14': [{ employeeGuid: 'W1', employeeName: 'Wage One', payRate: 9 }],
      },
    },
    exclusions: [],
    ruleCatalog: [{ rule_id: 'MINWAGE', params: '{"foo":"bar"}' }],
  });

  assert.equal(result.findings.length, 0);
}

module.exports = {
  testRunValidationFindsNewEmpRateDept,
  testRunValidationHonorsExclusionsAndActiveRules,
  testValidationEngineDoesNotImportAnalyticsProvider,
  testValidationEngineDoesNotCallEraLaborEndpoint,
  testFetchToastRowsForPeriodsUsesStandardOnlyAndLoadsSelectedAndPrior,
  testStandardJoinNormalizesEmployeeJobAndRateFields,
  testRunValidationMissingIdRule,
  testRunValidationMissingIdInactiveDoesNotEmit,
  testRunValidationOtThresholdRule,
  testRunValidationOtThresholdInvalidConfigSkips,
  testRunValidationMinWageRule,
  testRunValidationMinWageInvalidConfigSkips,
};
