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
  try {
    if (emailProvider.sendEmail) {
      const result = emailProvider.sendEmail(payload);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => console.error('FAILURE EMAIL ERROR', err.message || err));
      }
    } else {
      console.error('FAILURE EMAIL', payload);
    }
  } catch (err) {
    console.error('FAILURE EMAIL ERROR', err.message || err);
  }
  return payload;
}

module.exports = { notifyFailure, buildFailurePayload };
