const { notifyFailure } = require('./failureService');
const { issueToken, validateToken, getToken, markTokenClicked } = require('./tokenService');
const { createRunRecord, appendEvent, getRun, lockRun } = require('./runManager');
const emailProvider = require('../providers/emailProvider');

function approvalFailure(details, failureNotifier = notifyFailure) {
  try {
    failureNotifier(details, emailProvider);
  } catch (err) {
    console.error('failure notifier error', err);
  }
}

function approveAction(tokenId, { failureNotifier = notifyFailure } = {}) {
  const token = getToken(tokenId);
  const validation = validateToken(token);
  if (!validation.valid) {
    approvalFailure({ step: 'approve', error: `invalid_token:${validation.reason}`, runId: token ? token.run_id : null }, failureNotifier);
    return { status: 'invalid', reason: validation.reason };
  }
  if (token.action !== 'approve') {
    approvalFailure({ step: 'approve', error: 'invalid_action', runId: token.run_id }, failureNotifier);
    markTokenClicked(token);
    return { status: 'invalid', reason: 'invalid_action' };
  }
  const run = getRun(token.run_id);
  if (!run) {
    approvalFailure({ step: 'approve', error: 'missing_run', runId: token.run_id }, failureNotifier);
    markTokenClicked(token);
    return { status: 'missing_run' };
  }
  markTokenClicked(token);
  if (run.locked) {
    appendEvent(run, 'approval_noop', { token_id: token.token_id, reason: 'locked' });
    return { status: 'locked', run };
  }
  const lockResult = lockRun(run, { action: 'approve', token_id: token.token_id });
  appendEvent(run, 'approved', { token_id: token.token_id, lock: lockResult.locked });
  return { status: lockResult.locked ? 'approved' : 'locked', run };
}

async function sendTokens(run, approveToken, rerunToken, failureNotifier) {
  const recipients = (process.env.APPROVAL_RECIPIENTS || '').split(',').map((r) => r.trim()).filter(Boolean);
  if (!recipients.length) return;
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';
  const approvalLink = `${baseUrl}/approve?token=${approveToken.token_id}`;
  const rerunLink = `${baseUrl}/rerun?token=${rerunToken.token_id}`;
  const subject = `Payroll approval for ${run.client_location_id || 'unknown'} ${run.period_start || ''}-${run.period_end || ''}`;
  const body = `Approve: ${approvalLink}\nRe-run: ${rerunLink}`;
  await Promise.all(
    recipients.map(async (to) => {
      try {
        await emailProvider.sendEmail({ to, subject, body });
      } catch (err) {
        approvalFailure({ step: 'email_send', error: err.message || err, runId: run.id }, failureNotifier);
      }
    }),
  );
}

function rerunAction(tokenId, { failureNotifier = notifyFailure } = {}) {
  const token = getToken(tokenId);
  const validation = validateToken(token);
  if (!validation.valid) {
    approvalFailure({ step: 'rerun', error: `invalid_token:${validation.reason}`, runId: token ? token.run_id : null }, failureNotifier);
    return { status: 'invalid', reason: validation.reason };
  }
  if (token.action !== 'rerun') {
    approvalFailure({ step: 'rerun', error: 'invalid_action', runId: token.run_id }, failureNotifier);
    markTokenClicked(token);
    return { status: 'invalid', reason: 'invalid_action' };
  }
  const sourceRun = getRun(token.run_id);
  if (!sourceRun) {
    approvalFailure({ step: 'rerun', error: 'missing_run', runId: token.run_id }, failureNotifier);
    markTokenClicked(token);
    return { status: 'missing_run' };
  }
  markTokenClicked(token);
  const newRun = createRunRecord({
    clientLocationId: sourceRun.client_location_id,
    periodStart: sourceRun.period_start,
    periodEnd: sourceRun.period_end,
  });
  newRun.rerun_of = sourceRun.id;
  appendEvent(sourceRun, 'rerun_requested', { token_id: token.token_id, new_run_id: newRun.id });
  appendEvent(newRun, 'rerun_created', { from_run: sourceRun.id });

  const approveToken = issueToken({ action: 'approve', runId: newRun.id, periodStart: newRun.period_start, periodEnd: newRun.period_end });
  const rerunToken = issueToken({ action: 'rerun', runId: newRun.id, periodStart: newRun.period_start, periodEnd: newRun.period_end });
  sendTokens(newRun, approveToken, rerunToken, failureNotifier);

  return {
    status: 'rerun_created',
    run: newRun,
    tokens: { approve: approveToken, rerun: rerunToken },
  };
}

module.exports = { approveAction, rerunAction };
