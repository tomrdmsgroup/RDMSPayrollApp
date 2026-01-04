// server/src/domain/emailComposer.js

function composeEmail(outcome, run) {
  if (!outcome || !run) {
    return {
      ok: false,
      error: 'missing_outcome_or_run',
    };
  }

  const delivery = outcome.delivery || {};
  const recipients = delivery.recipients || [];

  if (!recipients.length) {
    return {
      ok: false,
      error: 'missing_recipients',
    };
  }

  const client = run.client_location_id || 'Unknown Location';
  const period =
    run.period_start && run.period_end
      ? `${run.period_start} to ${run.period_end}`
      : 'Unknown Period';

  const subject = `Payroll Validation Results — ${client} — ${period}`;

  const approveUrl = outcome.actions?.approve_url || '#';
  const rerunUrl = outcome.actions?.rerun_url || '#';

  const text = `
Payroll Validation Results

Location: ${client}
Period: ${period}

Approve Payroll:
${approveUrl}

Rerun Audit:
${rerunUrl}
`;

  const html = `
<html>
  <body>
    <h2>Payroll Validation Results</h2>
    <p><strong>Location:</strong> ${client}</p>
    <p><strong>Period:</strong> ${period}</p>

    <p>
      <a href="${approveUrl}">Approve Payroll</a>
    </p>
    <p>
      <a href="${rerunUrl}">Rerun Audit</a>
    </p>
  </body>
</html>
`;

  return {
    ok: true,
    subject,
    text,
    html,
  };
}

module.exports = { composeEmail };
