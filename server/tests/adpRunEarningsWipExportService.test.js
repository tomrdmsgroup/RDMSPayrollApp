const assert = require('assert');
const { createAdpRunEarningsWipDataset } = require('../src/domain/adpRunEarningsWipExportService');

function buildSetup() {
  return {
    'Payroll company code': 'IID-1',
    'PR Reg Earning Code': 'REG',
    'PR Overtime Earning Code': 'OT',
    'PR Double Time Earning Code': 'DT',
  };
}

function testExcludedStaffWinsBeforeValidationPlacement() {
  const rows = [
    {
      Employee: 'Carlisi, Michael',
      'Employee ID': 'Missing Employee ID',
      'Job Code': 'Missing job code',
      'Hourly Rate': '20',
      'Regular Hours': 8,
      __wip_excluded_reason: 'Excluded from Earnings WIP: staff member is on excluded staff list.',
      __wip_validation_note: 'Missing Employee ID and Missing Job Code',
    },
  ];
  const dataset = createAdpRunEarningsWipDataset({
    rows,
    setupAuditFields: buildSetup(),
    periodStart: '2026-04-01',
    periodEnd: '2026-04-14',
  });

  assert.equal(dataset.excludedRows.length, 1, 'excluded row should be listed in EXCLUDED STAFF');
  assert.equal(dataset.validationRows.length, 0, 'excluded row must not be listed in NEEDS ATTENTION');
  assert.equal(dataset.validRows.length, 0, 'excluded row must not be listed in top valid section');
}

function testValidationOutcomePreventsTopSectionPlacement() {
  const rows = [
    {
      Employee: 'Example, Employee',
      'Employee ID': 'Missing Employee ID',
      'Job Code': '100',
      'Hourly Rate': '22',
      'Regular Hours': 8,
      __wip_validation_note: 'Missing Employee Id.',
    },
  ];
  const dataset = createAdpRunEarningsWipDataset({
    rows,
    setupAuditFields: buildSetup(),
    periodStart: '2026-04-01',
    periodEnd: '2026-04-14',
  });

  assert.equal(dataset.validationRows.length, 1, 'failed validation row should appear in NEEDS ATTENTION');
  assert.equal(dataset.validationRows[0].wipNote, 'Missing Employee Id.');
  assert.equal(dataset.validRows.length, 0, 'failed validation row must not appear in top valid section');
}

module.exports = {
  testExcludedStaffWinsBeforeValidationPlacement,
  testValidationOutcomePreventsTopSectionPlacement,
};
