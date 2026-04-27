const assert = require('assert');
const { buildPayPeriodSelectorFromSortedRows } = require('../src/domain/airtableRecapService');

function mkRow(id, start, end, validation, submit, check) {
  return {
    record_id: id,
    fields: {
      'PR Period Start Date': start,
      'PR Period End Date': end,
      'PR Period Validation Date': validation,
      'PR Period Submit Date': submit,
      'PR Period Check Date': check,
    },
  };
}

function testSelectorCurrentAndNextByStartEndRange() {
  const rows = [
    mkRow('rec1', '2026-03-31', '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-10'),
    mkRow('rec2', '2026-04-07', '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-17'),
    mkRow('rec3', '2026-04-14', '2026-04-20', '2026-04-21', '2026-04-22', '2026-04-24'),
    mkRow('rec4', '2026-04-21', '2026-04-27', '2026-04-28', '2026-04-29', '2026-05-01'),
    mkRow('rec5', '2026-04-28', '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-08'),
  ];

  const selector = buildPayPeriodSelectorFromSortedRows(rows, '2026-04-27');
  assert.equal(selector.current_pay_period.record_id, 'rec4');
  assert.equal(selector.next_pay_period.record_id, 'rec5');
  assert.deepEqual(
    selector.prior_pay_periods.map((p) => p.record_id),
    ['rec3', 'rec2', 'rec1'],
  );
}

function testSelectorCurrentIgnoresSubmitDateForCurrentBucket() {
  const rows = [
    mkRow('rec1', '2026-04-21', '2026-04-27', '2026-04-28', '2026-04-24', '2026-05-01'),
    mkRow('rec2', '2026-04-28', '2026-05-04', '2026-05-05', '2026-05-06', '2026-05-08'),
  ];

  const selector = buildPayPeriodSelectorFromSortedRows(rows, '2026-04-25');
  assert.equal(selector.current_pay_period.record_id, 'rec1');
  assert.equal(selector.next_pay_period.record_id, 'rec2');
}

function testSelectorNoCurrentGapDoesNotThrowAndReturnsNextAndPriors() {
  const rows = [
    mkRow('rec1', '2026-04-01', '2026-04-05', '2026-04-06', '2026-04-07', '2026-04-09'),
    mkRow('rec2', '2026-04-10', '2026-04-15', '2026-04-16', '2026-04-17', '2026-04-19'),
  ];

  const selector = buildPayPeriodSelectorFromSortedRows(rows, '2026-04-07');
  assert.equal(selector.current_pay_period, null);
  assert.equal(selector.next_pay_period.record_id, 'rec2');
  assert.deepEqual(selector.prior_pay_periods.map((p) => p.record_id), ['rec1']);
}

function testSelectorBeforeFirstRowReturnsFirstAsNext() {
  const rows = [
    mkRow('rec1', '2026-04-07', '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-17'),
    mkRow('rec2', '2026-04-14', '2026-04-20', '2026-04-21', '2026-04-22', '2026-04-24'),
  ];

  const selector = buildPayPeriodSelectorFromSortedRows(rows, '2026-04-01');
  assert.equal(selector.current_pay_period, null);
  assert.equal(selector.next_pay_period.record_id, 'rec1');
  assert.deepEqual(selector.prior_pay_periods, []);
}

function testSelectorAfterLastRowReturnsAllAsPriorNewestFirst() {
  const rows = [
    mkRow('rec1', '2026-04-07', '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-17'),
    mkRow('rec2', '2026-04-14', '2026-04-20', '2026-04-21', '2026-04-22', '2026-04-24'),
    mkRow('rec3', '2026-04-21', '2026-04-27', '2026-04-28', '2026-04-29', '2026-05-01'),
  ];

  const selector = buildPayPeriodSelectorFromSortedRows(rows, '2026-05-10');
  assert.equal(selector.current_pay_period, null);
  assert.equal(selector.next_pay_period, null);
  assert.deepEqual(selector.prior_pay_periods.map((p) => p.record_id), ['rec3', 'rec2', 'rec1']);
}

module.exports = {
  testSelectorCurrentAndNextByStartEndRange,
  testSelectorCurrentIgnoresSubmitDateForCurrentBucket,
  testSelectorNoCurrentGapDoesNotThrowAndReturnsNextAndPriors,
  testSelectorBeforeFirstRowReturnsFirstAsNext,
  testSelectorAfterLastRowReturnsAllAsPriorNewestFirst,
};
