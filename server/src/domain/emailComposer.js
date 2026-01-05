// server/src/domain/emailComposer.js

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function joinBaseUrl(base, path) {
  const b = String(base || '').trim();
  const p = String(path || '').trim();

  if (!p) return '#';
  if (/^https?:\/\//i.test(p)) return p;
  if (!b) return p;

  const bNoSlash = b.endsWith('/') ? b.slice(0, -1) : b;
  const pWithSlash = p.startsWith('/') ? p : `/${p}`;
  return `${bNoSlash}${pWithSlash}`;
}

function formatPacificDateTime(isoString) {
  try {
    const d = isoString ? new Date(isoString) : new Date();
    return d.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch (_) {
    return '';
  }
}

function addDaysIso(isoString, days) {
  try {
    const d = isoString ? new Date(isoString) : new Date();
    d.setDate(d.getDate() + Number(days || 0));
    return d.toISOString();
  } catch (_) {
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }
}

function composeEmail(outcome, run) {
  if (!outcome || !run) {
    return { ok: false, error: 'missing_outcome_or_run' };
  }

  const delivery = outcome.delivery || {};
  const recipients = delivery.recipients || [];

  if (!recipients.length) {
    return { ok: false, error: 'missing_recipients' };
  }

  const client = run.client_location_id || 'Unknown Location';
  const period =
    run.period_start && run.period_end
      ? `${run.period_start} to ${run.period_end}`
      : 'Unknown Period';

  const subject = `Payroll Validation - ${client}`;

  const baseUrl = process.env.PUBLIC_BASE_URL || '';
  const approveUrlRaw = outcome.actions?.approve_url || '#';
  const rerunUrlRaw = outcome.actions?.rerun_url || '#';

  const approveUrl = joinBaseUrl(baseUrl, approveUrlRaw);
  const rerunUrl = joinBaseUrl(baseUrl, rerunUrlRaw);

  const generatedAtIso = new Date().toISOString();
  const generatedAtPacific = formatPacificDateTime(generatedAtIso) + ' (America/Los_Angeles)';

  // Tokens are currently created with a 7 day TTL.
  // Without extra DB reads, the cleanest reliable display is "Run created_at + 7 days".
  const expiresAtIso = addDaysIso(run.created_at || generatedAtIso, 7);
  const expiresAtPacific = formatPacificDateTime(expiresAtIso);

  const text =
`Payroll Validation - ${client}

Period: ${period}
Generated at: ${generatedAtPacific}

Hello,

This is an automated email. Your payroll period is now over and we will be working on processing payroll.
Please submit all required payroll documentation so that we can begin processing as soon as possible.
The deadline for all submissions is end of day today.

Below you will find an audit of your timecard data. Please review these results carefully.
If you find anything that requires your attention or an edit, you are responsible for making corrections
directly in your POS system. Our firm cannot make these changes for you due to the sensitive nature of
employee timecards.

Once all adjustments are made, payroll processing will not begin until you approve payroll.

Validation results will appear here once we wire Toast.

APPROVE PAYROLL:
${approveUrl}

RERUN AUDIT:
${rerunUrl}

Links expire at ${expiresAtPacific}. If the buttons don't work, reply to this email.
`;

  // Gmail-safe approach: single centered table, inline styles, button-style links.
  const html =
`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f3f4f6;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f3f4f6; padding:24px 0;">
      <tr>
        <td align="center" style="padding:0 12px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="width:640px; max-width:640px; background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.06);">
            <tr>
              <td style="padding:24px 24px 12px 24px;">
                <div style="font-family:Arial, Helvetica, sans-serif; font-size:22px; font-weight:700; color:#111827; line-height:1.25;">
                  Payroll Validation - ${escapeHtml(client)}
                </div>
                <div style="font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#374151; margin-top:10px; line-height:1.4;">
                  <div><strong>Period:</strong> ${escapeHtml(period)}</div>
                  <div style="margin-top:4px;"><strong>Generated at:</strong> ${escapeHtml(generatedAtPacific)}</div>
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:0 24px 8px 24px;">
                <div style="font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#111827; line-height:1.6;">
                  <p style="margin:0 0 12px 0;">Hello,</p>
                  <p style="margin:0 0 12px 0;">
                    This is an automated email. Your payroll period is now over and we will be working on processing payroll.
                    Please submit all required payroll documentation so that we can begin processing as soon as possible.
                    The deadline for all submissions is <strong>end of day today</strong>.
                  </p>
                  <p style="margin:0 0 12px 0;">
                    Below you will find an audit of your timecard data. Please review these results carefully.
                    If you find anything that requires your attention or an edit, you are responsible for making corrections
                    directly in your POS system. Our firm cannot make these changes for you due to the sensitive nature of
                    employee timecards.
                  </p>
                  <p style="margin:0 0 12px 0;">
                    Once all adjustments are made, payroll processing will not begin until you click the
                    <strong>APPROVE PAYROLL</strong> button below.
                  </p>
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:0 24px 16px 24px;">
                <div style="font-family:Arial, Helvetica, sans-serif; font-size:14px; color:#6b7280; line-height:1.6; padding:12px; border:1px solid #e5e7eb; border-radius:10px; background-color:#fafafa;">
                  <strong style="color:#111827;">Validation</strong> results will appear here once we wire Toast.
                </div>
              </td>
            </tr>

            <tr>
              <td align="left" style="padding:0 24px 24px 24px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding-right:12px; padding-bottom:12px;">
                      <a href="${escapeHtml(approveUrl)}"
                         style="display:inline-block; font-family:Arial, Helvetica, sans-serif; font-size:14px; font-weight:700; color:#ffffff; text-decoration:none; background-color:#16a34a; border-radius:10px; padding:12px 18px;">
                        APPROVE PAYROLL
                      </a>
                    </td>
                    <td style="padding-bottom:12px;">
                      <a href="${escapeHtml(rerunUrl)}"
                         style="display:inline-block; font-family:Arial, Helvetica, sans-serif; font-size:14px; font-weight:700; color:#ffffff; text-decoration:none; background-color:#dc2626; border-radius:10px; padding:12px 18px;">
                        RERUN AUDIT
                      </a>
                    </td>
                  </tr>
                </table>

                <div style="font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#6b7280; line-height:1.5; margin-top:8px;">
                  Links expire at ${escapeHtml(expiresAtPacific)}. If the buttons don't work, reply to this email.
                </div>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

  return { ok: true, subject, text, html };
}

module.exports = { composeEmail };
