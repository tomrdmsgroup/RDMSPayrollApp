const FAILURE_EMAIL = process.env.FAILURE_EMAIL || '911@rdmsgroup.com';

function buildFailurePayload({ clientLocation, period, step, error, runId }) {
  return {
    to: FAILURE_EMAIL,
    subject: `PAYROLL FAILURE: ${clientLocation || 'unknown'} ${period || ''}`.trim(),
    body: `Step: ${step}\nError: ${error}\nRun: ${runId ? 'RUN-' + runId : 'unknown'}`,
  };
}

function notifyFailure(details, emailProvider = console) {
  const payload = buildFailurePayload(details);
  if (emailProvider.sendEmail) {
    emailProvider.sendEmail(payload);
  } else {
    console.error('FAILURE EMAIL', payload);
  }
  return payload;
}

module.exports = { notifyFailure, buildFailurePayload };
