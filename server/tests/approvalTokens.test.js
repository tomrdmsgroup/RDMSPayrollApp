const assert = require('assert');
const { issueToken, validateToken, clearTokens } = require('../src/domain/tokenService');
const { createRunRecord, resetRuns, getRun } = require('../src/domain/runManager');
const { approveAction, rerunAction } = require('../src/domain/approvalService');

function resetState() {
  clearTokens();
  resetRuns();
}

function testTokenStoreIsPersistent() {
  resetState();
  const token = issueToken({ action: 'approve', ttlMinutes: 10 });
  assert.equal(token.recipient_email, undefined, 'recipient email must not be stored');
  const validation = validateToken(token);
  assert.equal(validation.valid, true, 'issued token should validate');
  const fetched = validateToken(token.token_id);
  assert.equal(fetched.valid, true, 'token id lookup should work from store');
}

function testApprovalFirstWriterWins() {
  resetState();
  const run = createRunRecord({ clientLocationId: 'LOC1', periodStart: '2024-01-01', periodEnd: '2024-01-15' });
  const tokenA = issueToken({ action: 'approve', runId: run.id, periodStart: run.period_start, periodEnd: run.period_end });
  const tokenB = issueToken({ action: 'approve', runId: run.id, periodStart: run.period_start, periodEnd: run.period_end });
  const first = approveAction(tokenA.token_id);
  assert.equal(first.status, 'approved', 'first approval should lock');
  assert.equal(getRun(run.id).locked, true, 'run must be locked after first approval');
  const second = approveAction(tokenB.token_id);
  assert.equal(second.status, 'locked', 'subsequent approvals should be no-op');
}

function testRerunCreatesNewRunAndTokens() {
  resetState();
  const run = createRunRecord({ clientLocationId: 'LOC1', periodStart: '2024-02-01', periodEnd: '2024-02-15' });
  const rerunToken = issueToken({ action: 'rerun', runId: run.id, periodStart: run.period_start, periodEnd: run.period_end });
  const outcome = rerunAction(rerunToken.token_id);
  assert.equal(outcome.status, 'rerun_created', 'rerun should succeed');
  assert.ok(outcome.run.id !== run.id, 'rerun creates a new run id');
  assert.ok(outcome.tokens.approve.token_id, 'approve token generated for rerun');
  assert.ok(outcome.tokens.rerun.token_id, 'rerun token generated for rerun');
}

function testInvalidTokenTriggersFailure() {
  resetState();
  let failureCalled = false;
  const customFailure = () => {
    failureCalled = true;
  };
  const result = approveAction('missing-token', { failureNotifier: customFailure });
  assert.equal(result.status, 'invalid', 'missing token should be invalid');
  assert.equal(failureCalled, true, 'failure notifier should fire on invalid token');
}

module.exports = {
  testTokenStoreIsPersistent,
  testApprovalFirstWriterWins,
  testRerunCreatesNewRunAndTokens,
  testInvalidTokenTriggersFailure,
};
