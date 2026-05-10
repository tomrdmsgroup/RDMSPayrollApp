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


async function testRunValidationOtThresholdUsesActiveRuleConfigParams() {
  const result = await runValidation({
    run: { id: 109, client_location_id: 'Test Location', period_start: '2026-03-01', period_end: '2026-03-14' },
    context: {
      active_rule_ids: ['OTTHRESHOLD'],
      active_rule_configs: {
        OTTHRESHOLD: { params: { threshold: 4 } },
      },
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-03-01__2026-03-14': [
          { employeeGuid: 'O1', employeeName: 'Over One', overtimeHours: 4.5 },
        ],
      },
    },
    exclusions: [],
    ruleCatalog: [{ rule_id: 'OTTHRESHOLD', rule_name: 'OT over X Hours', params: { threshold: 40 } }],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].rule_id, 'OTTHRESHOLD');
  assert.equal(result.findings[0].toast_employee_id, 'O1');
}

async function testRunValidationMinWageUsesActiveRuleConfigParams() {
  const result = await runValidation({
    run: { id: 110, client_location_id: 'Test Location', period_start: '2026-03-01', period_end: '2026-03-14' },
    context: {
      active_rule_ids: ['MINWAGE'],
      active_rule_configs: {
        MINWAGE: { params: JSON.stringify({ minimumWage: 15 }) },
      },
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-03-01__2026-03-14': [
          { employeeGuid: 'W1', employeeName: 'Wage One', payRate: 14 },
        ],
      },
    },
    exclusions: [],
    ruleCatalog: [{ rule_id: 'MINWAGE', rule_name: 'Under Minimum Wage', params: { minimumWage: 7.25 } }],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].rule_id, 'MINWAGE');
  assert.equal(result.findings[0].toast_employee_id, 'W1');
}

async function testRunValidationLateClockoutRule() {
  const result = await runValidation({
    run: { id: 111, client_location_id: 'Test Location', period_start: '2026-03-01', period_end: '2026-03-14' },
    context: {
      active_rule_ids: ['LATECLOCKOUT'],
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-03-01__2026-03-14': [
          { employeeGuid: 'L1', employeeName: 'Late One', inDate: '2026-03-03T20:00:00', outDate: '2026-03-04T03:31:00' },
          { employeeGuid: 'L4', employeeName: 'Late Four', inDate: '2026-03-03T20:00:00', outDate: '2026-03-04T05:03:00' },
          { employeeGuid: 'L2', employeeName: 'Edge Two', inDate: '2026-03-03T20:00:00', outDate: '2026-03-04T03:30:00' },
          { employeeGuid: 'L3', employeeName: 'Early Three', inDate: '2026-03-03T20:00:00', outDate: '2026-03-04T03:29:00' },
          { employeeGuid: 'L5', employeeName: 'Pm Nine', inDate: '2026-03-03T13:00:00', outDate: '2026-03-03T21:47:00' },
          { employeeGuid: 'L6', employeeName: 'Pm Ten', inDate: '2026-03-03T13:00:00', outDate: '2026-03-03T22:11:00' },
          { employeeGuid: 'LX', employeeName: 'Excluded Late', inDate: '2026-03-03T20:00:00', outDate: '2026-03-04T04:00:00' },
        ],
      },
    },
    exclusions: [{ toast_employee_id: ' LX ', active: true, effective_from: '2026-01-01', effective_to: '2026-12-31' }],
  });

  const lateIds = result.findings.filter((f) => f.rule_id === 'LATECLOCKOUT').map((f) => f.toast_employee_id).sort();
  assert.deepEqual(lateIds, ['L1', 'L4']);
}

async function testRunValidationLongShiftRuleAndConfigBehavior() {
  const baseContext = {
    active_rule_ids: ['LONGSHIFT'],
    comparison_periods: [],
    toast_rows_by_period: {
      '2026-03-01__2026-03-14': [
        { employeeGuid: 'S1', employeeName: 'Shift One', inDate: '2026-03-03T09:00:00', outDate: '2026-03-03T17:30:00' },
        { employeeGuid: 'S2', employeeName: 'Shift Two', inDate: '2026-03-03T09:00:00', outDate: '2026-03-03T17:00:00' },
        { employeeGuid: 'SX', employeeName: 'Excluded Shift', inDate: '2026-03-03T09:00:00', outDate: '2026-03-03T20:00:00' },
      ],
    },
  };

  const withActiveConfig = await runValidation({
    run: { id: 112, client_location_id: 'Test Location', period_start: '2026-03-01', period_end: '2026-03-14' },
    context: { ...baseContext, active_rule_configs: { LONGSHIFT: { params: JSON.stringify({ maxHours: 8 }) } } },
    exclusions: [{ toast_employee_id: ' SX ', active: true, effective_from: '2026-01-01', effective_to: '2026-12-31' }],
    ruleCatalog: [{ rule_id: 'LONGSHIFT', params: { threshold: 12 } }],
  });
  assert.equal(withActiveConfig.findings.length, 1);
  assert.equal(withActiveConfig.findings[0].toast_employee_id, 'S1');

  const invalidConfig = await runValidation({
    run: { id: 113, client_location_id: 'Test Location', period_start: '2026-03-01', period_end: '2026-03-14' },
    context: baseContext,
    exclusions: [],
    ruleCatalog: [{ rule_id: 'LONGSHIFT', params: '{"foo":"bar"}' }],
  });
  assert.equal(invalidConfig.findings.length, 0);
}

async function testRunValidationDupTimeRule() {
  const result = await runValidation({
    run: { id: 114, client_location_id: 'Test Location', period_start: '2026-03-01', period_end: '2026-03-14' },
    context: {
      active_rule_ids: ['DUPTIME'],
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-03-01__2026-03-14': [
          { employeeGuid: 'D1', employeeName: 'Dup One', inDate: '2026-03-05T09:00:00', outDate: '2026-03-05T12:00:00' },
          { employeeGuid: 'D1', employeeName: 'Dup One', inDate: '2026-03-05T11:00:00', outDate: '2026-03-05T14:00:00' },
          { employeeGuid: 'D1', employeeName: 'Dup One', inDate: '2026-03-06T10:00:00', outDate: '2026-03-06T12:00:00' },
          { employeeGuid: 'D1', employeeName: 'Dup One', inDate: '2026-03-06T10:00:00', outDate: '2026-03-06T12:00:00' },
          { employeeGuid: 'D1', employeeName: 'Dup One', inDate: '2026-03-07T09:00:00', outDate: '2026-03-07T10:00:00' },
          { employeeGuid: 'D1', employeeName: 'Dup One', inDate: '2026-03-07T10:00:00', outDate: '2026-03-07T11:00:00' },
          { employeeGuid: 'D2', employeeName: 'Other Two', inDate: '2026-03-05T09:30:00', outDate: '2026-03-05T10:30:00' },
          { employeeGuid: 'DX', employeeName: 'Excluded Dup', inDate: '2026-03-05T09:00:00', outDate: '2026-03-05T12:00:00' },
          { employeeGuid: 'DX', employeeName: 'Excluded Dup', inDate: '2026-03-05T10:00:00', outDate: '2026-03-05T11:00:00' },
        ],
      },
    },
    exclusions: [{ toast_employee_id: ' DX ', active: true, effective_from: '2026-01-01', effective_to: '2026-12-31' }],
  });

  assert.equal(result.findings.length, 2);
  assert.equal(result.findings.every((f) => f.toast_employee_id === 'D1'), true);
}


async function testRunValidationLateClockoutUsesLocationTimezoneFromContext() {
  const result = await runValidation({
    run: { id: 116, client_location_id: 'Sushi Ran', period_start: '2026-04-01', period_end: '2026-04-30' },
    context: {
      active_rule_ids: ['LATECLOCKOUT'],
      location_timezone: 'America/Los_Angeles',
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-04-01__2026-04-30': [
          // 10:03 PM PT (05:03 AM UTC next day) should not be flagged
          { employeeGuid: 'TZ1', employeeName: 'Pacific PM', inDate: '2026-04-18T22:55:00.000Z', outDate: '2026-04-19T05:03:00.000Z' },
          // 5:03 AM PT should be flagged
          { employeeGuid: 'TZ2', employeeName: 'Pacific AM', inDate: '2026-04-19T07:55:00.000Z', outDate: '2026-04-19T12:03:00.000Z' },
        ],
      },
    },
    exclusions: [],
  });

  const lateIds = result.findings.filter((f) => f.rule_id === 'LATECLOCKOUT').map((f) => f.toast_employee_id);
  assert.deepEqual(lateIds, ['TZ2']);
}

async function testRunValidationShiftRulesUseLocationTimezoneForEvaluationAndDetail() {
  const result = await runValidation({
    run: { id: 115, client_location_id: 'Sushi Ran', period_start: '2026-04-01', period_end: '2026-04-30' },
    context: {
      active_rule_ids: ['LATECLOCKOUT', 'LONGSHIFT', 'DUPTIME'],
      timezone: 'America/Los_Angeles',
      comparison_periods: [],
      toast_rows_by_period: {
        '2026-04-01__2026-04-30': [
          // 9:43 PM PT out (should NOT late-flag even though UTC is next-day 04:43)
          { employeeGuid: 'T1', employeeName: 'Local PM', inDate: '2026-04-19T00:20:00.000Z', outDate: '2026-04-19T04:43:00.000Z' },
          // 5:03 AM PT out (should late-flag)
          { employeeGuid: 'T2', employeeName: 'Local AM', inDate: '2026-04-19T06:55:00.000Z', outDate: '2026-04-19T12:03:00.000Z' },
          // long shift: 8.5h absolute duration, detail should show PT clock times
          { employeeGuid: 'T3', employeeName: 'Long Shift', inDate: '2026-04-19T16:00:00.000Z', outDate: '2026-04-20T00:30:00.000Z' },
          // duplicate overlap: absolute overlap; detail should show PT
          { employeeGuid: 'T4', employeeName: 'Dup Shift', inDate: '2026-04-19T16:00:00.000Z', outDate: '2026-04-19T19:00:00.000Z' },
          { employeeGuid: 'T4', employeeName: 'Dup Shift', inDate: '2026-04-19T18:00:00.000Z', outDate: '2026-04-19T21:00:00.000Z' },
        ],
      },
      active_rule_configs: { LONGSHIFT: { params: JSON.stringify({ maxHours: 8 }) } },
    },
    exclusions: [],
  });

  const lateIds = result.findings.filter((f) => f.rule_id === 'LATECLOCKOUT').map((f) => f.toast_employee_id);
  assert.deepEqual(lateIds, ['T2']);

  const lateDetail = result.findings.find((f) => f.rule_id === 'LATECLOCKOUT' && f.toast_employee_id === 'T2')?.detail || '';
  assert.equal(lateDetail.includes('in 11:55 PM'), true);
  assert.equal(lateDetail.includes('out 5:03 AM'), true);

  const longDetail = result.findings.find((f) => f.rule_id === 'LONGSHIFT' && f.toast_employee_id === 'T3')?.detail || '';
  assert.equal(longDetail.includes('in 9:00 AM'), true);
  assert.equal(longDetail.includes('out 5:30 PM'), true);

  const dupDetail = result.findings.find((f) => f.rule_id === 'DUPTIME' && f.toast_employee_id === 'T4')?.detail || '';
  assert.equal(dupDetail.includes('9:00 AM-12:00 PM overlaps 11:00 AM-2:00 PM'), true);
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
  testRunValidationOtThresholdUsesActiveRuleConfigParams,
  testRunValidationMinWageUsesActiveRuleConfigParams,
  testRunValidationLateClockoutRule,
  testRunValidationLongShiftRuleAndConfigBehavior,
  testRunValidationDupTimeRule,
  testRunValidationLateClockoutUsesLocationTimezoneFromContext,
  testRunValidationShiftRulesUseLocationTimezoneForEvaluationAndDetail,
};
