const assert = require('assert');
const { buildPayPeriodSelectorModel } = require('../src/domain/airtableRecapService');

function makeRow(id, start, end, validation, submit) {
  return {
    id,
    fields: {
      'PR Period Start Date': start,
      'PR Period End Date': end,
      'PR Period Validation Date': validation,
      'PR Period Submit Date': submit,
    },
  };
}

function testDefaultsToCurrentWhenOnOrBeforeValidationDate() {
  const rows = [
    makeRow('p1', '2026-03-01', '2026-03-14', '2026-03-16', '2026-03-17'),
    makeRow('p2', '2026-03-15', '2026-03-28', '2026-03-30', '2026-03-31'),
    makeRow('p3', '2026-03-29', '2026-04-11', '2026-04-13', '2026-04-14'),
  ];

  const model = buildPayPeriodSelectorModel(rows, new Date('2026-03-28T12:00:00Z'));
  assert.equal(model.default_option, 'current_pay_period', 'should default to current pay period');
  assert.equal(model.selected_period.record_id, 'p2', 'selected period should be current');
  assert.equal(model.next_pay_period.record_id, 'p3', 'next period should be available');
  assert.equal(model.prior_pay_periods.length, 1, 'prior list should include older periods');
}

function testDefaultsToNextWhenAfterValidationDate() {
  const rows = [
    makeRow('p1', '2026-03-01', '2026-03-14', '2026-03-16', '2026-03-17'),
    makeRow('p2', '2026-03-15', '2026-03-28', '2026-03-30', '2026-03-31'),
    makeRow('p3', '2026-03-29', '2026-04-11', '2026-04-13', '2026-04-14'),
  ];

  const model = buildPayPeriodSelectorModel(rows, new Date('2026-03-31T12:00:00Z'));
  assert.equal(model.default_option, 'next_pay_period', 'should default to next pay period');
  assert.equal(model.selected_period.record_id, 'p3', 'selected period should be next');
}

module.exports = {
  testDefaultsToCurrentWhenOnOrBeforeValidationDate,
  testDefaultsToNextWhenAfterValidationDate,
};
