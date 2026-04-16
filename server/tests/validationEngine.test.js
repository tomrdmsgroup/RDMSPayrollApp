const assert = require('assert');
const { runValidation } = require('../src/domain/validationEngine');

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
            regularHours: 10,
            regularCost: 200,
          },
          {
            employeeGuid: 'E2',
            employeeName: 'Bri Baker',
            jobName: 'Bar',
            regularHours: 8,
            regularCost: 160,
          },
        ],
        [prior1Key]: [
          {
            employeeGuid: 'E1',
            employeeName: 'Alex Able',
            jobName: 'Host',
            regularHours: 8,
            regularCost: 160,
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
          { employeeGuid: 'EX1', employeeName: 'Excluded Person', jobName: 'Server', regularHours: 8, regularCost: 120 },
          { employeeGuid: 'A1', employeeName: 'Active Person', jobName: 'Server', regularHours: 8, regularCost: 120 },
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

module.exports = {
  testRunValidationFindsNewEmpRateDept,
  testRunValidationHonorsExclusionsAndActiveRules,
};
