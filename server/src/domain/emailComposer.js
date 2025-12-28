// server/src/domain/emailComposer.js

function normalizeStatus(status) {
  const s = (status || '').toString().toLowerCase().trim();
  if (s === 'error' || s === 'failure' || s === 'warning' || s === 'success') return s;
  if (!s) return 'warning';
  return 'warning';
}

function statusRank(status) {
  const s = normalizeStatus(status);
  if (s === 'error') return 1;
  if (s === 'failure') return 2;
  if (s === 'warning') return 3;
  return 4; // success
}

function safeStr(v) {
  if (v == null) return '';
  return `${v}`.trim();
}

function buildSubject({ client_location_id, period_start, period_end }) {
  const parts = ['Payroll Validation Results'];
  if (client_location_id) parts.push(safeStr(client_location_id));
  if (period_start && period_end) parts.push(`${safeStr(period_start)} to ${safeStr(period_end)}`);
  return parts.join(' — ');
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const ra = statusRank(a?.status);
    const rb = statusRank(b?.status);
    if (ra !== rb) return ra - rb;

    const ca = safeStr(a?.code).toLowerCase();
    const cb = safeStr(b?.code).toLowerCase();
    if (ca < cb) return -1;
    if (ca > cb) return 1;

    const ma = safeStr(a?.message).toLowerCase();
    const mb = safeStr(b?.message).toLowerCase();
    if (ma < mb) return -1;
    if (ma > mb) return 1;

    return 0;
  });
}

function groupFindings(findings) {
  const groups = {
    error: [],
    failure: [],
    warning: [],
    success: [],
  };

  for (const f of findings) {
    const s = normalizeStatus(f?.status);
    if (!groups[s]) groups.warning.push(f);
    else groups[s].push(f);
  }

  return groups;
}

function formatFindingLine(f) {
  const code = safeStr(f?.code);
  const msg = safeStr(f?.message) || 'Validation finding';
  const prefix = code ? `[${code}] ` : '';
  return `${prefix}${msg}`;
}

function composeText(outcome, run) {
  const approveUrl = safeStr(outcome?.actions?.approve_url);
  const rerunUrl = safeStr(outcome?.actions?.rerun_url);

  const findings = Array.isArray(outcome?.findings) ? outcome.findings : [];
  const sorted = sortFindings(findings);
  const groups = groupFindings(sorted);

  const lines = [];

  lines.push('Payroll validation has completed for the period listed below.');
  if (run?.period_start && run?.period_end) {
    lines.push(`Period: ${safeStr(run.period_start)} to ${safeStr(run.period_end)}`);
  }
  if (run?.client_location_id) {
    lines.push(`Client/Location: ${safeStr(run.client_location_id)}`);
  }
  lines.push('');
  lines.push('Actions:');
  if (approveUrl) lines.push(`APPROVE PAYROLL: ${approveUrl}`);
  if (rerunUrl) lines.push(`RERUN AUDIT: ${rerunUrl}`);
  lines.push('');
  lines.push('Audit Findings');
  lines.push('');

  const order = ['error', 'failure', 'warning', 'success'];
  for (const key of order) {
    const bucket = groups[key] || [];
    if (bucket.length === 0) continue;

    lines.push(key.toUpperCase());
    for (const f of bucket) {
      lines.push(`- ${formatFindingLine(f)}`);
      const details = safeStr(f?.details);
      if (details) lines.push(`  Details: ${details}`);
    }
    lines.push('');
  }

  lines.push('If you have questions, reply to this email.');

  return lines.join('\n').trim();
}

function escapeHtml(s) {
  return safeStr(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buttonHtml(href, label) {
  const url = escapeHtml(href);
  const text = escapeHtml(label);

  return `
    <a href="${url}"
       style="display:inline-block;padding:10px 14px;margin:6px 10px 6px 0;
              text-decoration:none;border-radius:6px;border:1px solid #111;
              font-family:Arial,sans-serif;font-size:14px;color:#111;">
      ${text}
    </a>
  `.trim();
}

function composeHtml(outcome, run) {
  const approveUrl = safeStr(outcome?.actions?.approve_url);
  const rerunUrl = safeStr(outcome?.actions?.rerun_url);

  const findings = Array.isArray(outcome?.findings) ? outcome.findings : [];
  const sorted = sortFindings(findings);
  const groups = groupFindings(sorted);

  const headerLines = [];
  headerLines.push('<p>Payroll validation has completed for the period listed below.</p>');

  const meta = [];
  if (run?.period_start && run?.period_end) {
    meta.push(`<div><strong>Period:</strong> ${escapeHtml(run.period_start)} to ${escapeHtml(run.period_end)}</div>`);
  }
  if (run?.client_location_id) {
    meta.push(`<div><strong>Client/Location:</strong> ${escapeHtml(run.client_location_id)}</div>`);
  }
  if (meta.length) headerLines.push(`<div style="margin:10px 0 14px 0;">${meta.join('')}</div>`);

  const buttons = [];
  if (approveUrl) buttons.push(buttonHtml(approveUrl, 'APPROVE PAYROLL'));
  if (rerunUrl) buttons.push(buttonHtml(rerunUrl, 'RERUN AUDIT'));

  const findingsHtml = [];
  findingsHtml.push('<h3>Audit Findings</h3>');

  const order = ['error', 'failure', 'warning', 'success'];
  for (const key of order) {
    const bucket = groups[key] || [];
    if (bucket.length === 0) continue;

    findingsHtml.push(`<h4>${escapeHtml(key.toUpperCase())}</h4>`);
    findingsHtml.push('<ul>');
    for (const f of bucket) {
      const line = escapeHtml(formatFindingLine(f));
      const details = safeStr(f?.details);
      if (details) {
        findingsHtml.push(
          `<li>${line}<div style="margin-top:4px;font-size:12px;color:#444;">Details: ${escapeHtml(details)}</div></li>`,
        );
      } else {
        findingsHtml.push(`<li>${line}</li>`);
      }
    }
    findingsHtml.push('</ul>');
  }

  const footer = '<p>If you have questions, reply to this email.</p>';

  return `
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.4;color:#111;">
      ${headerLines.join('\n')}
      <div style="margin:12px 0 18px 0;">
        ${buttons.join('\n')}
      </div>
      ${findingsHtml.join('\n')}
      ${footer}
    </div>
  `.trim();
}

/**
 * composeEmail(outcome, run)
 *
 * Returns:
 * - subject
 * - text
 * - html
 *
 * Does not send email. Step 2 only.
 */
function composeEmail(outcome, run) {
  const subject =
    safeStr(outcome?.delivery?.subject) ||
    buildSubject({
      client_location_id: run?.client_location_id,
      period_start: run?.period_start,
      period_end: run?.period_end,
    });

  const text = composeText(outcome, run);
  const html = composeHtml(outcome, run);

  return { subject, text, html };
}

module.exports = {
  composeEmail,
  buildSubject,
  normalizeStatus,
  groupFindings,
  sortFindings,
};
