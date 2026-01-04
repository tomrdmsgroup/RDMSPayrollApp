// server/src/domain/emailComposer.js

function normalizeBaseUrl(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function toAbsoluteUrl(baseUrl, maybePath) {
  const p = String(maybePath || "").trim();
  if (!p) return "";

  // Already absolute
  if (p.startsWith("http://") || p.startsWith("https://")) return p;

  const base = normalizeBaseUrl(baseUrl);
  if (!base) return p; // fall back to relative, but we prefer absolute

  // Ensure path begins with "/"
  const path = p.startsWith("/") ? p : `/${p}`;
  return `${base}${path}`;
}

function safeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/**
 * Builds subject + rendered HTML/text for a payroll validation outcome email.
 *
 * Expected outcome shape (based on your current API response):
 * - outcome.run_id
 * - outcome.delivery.from, outcome.delivery.reply_to, outcome.delivery.recipients[]
 * - outcome.delivery.subject (optional)
 * - outcome.actions.approve_url, outcome.actions.rerun_url
 * - outcome.policy_snapshot.delivery (optional)
 *
 * Expected run shape (optional but recommended):
 * - run.client_location_id
 * - run.period_start
 * - run.period_end
 */
function composeOutcomeEmail({ run, outcome, publicBaseUrl }) {
  if (!outcome) throw new Error("compose_email_failed:missing_outcome");

  const baseUrl = normalizeBaseUrl(
    publicBaseUrl || process.env.PUBLIC_BASE_URL || ""
  );

  const clientLocation = safeText(run && run.client_location_id);
  const periodStart = safeText(run && run.period_start);
  const periodEnd = safeText(run && run.period_end);

  const approveUrl = toAbsoluteUrl(baseUrl, outcome.actions && outcome.actions.approve_url);
  const rerunUrl = toAbsoluteUrl(baseUrl, outcome.actions && outcome.actions.rerun_url);

  const subject =
    safeText(outcome.delivery && outcome.delivery.subject) ||
    `Payroll Validation Results - ${clientLocation || "Unknown Location"} - ${periodStart || "Unknown"} to ${periodEnd || "Unknown"}`;

  const html = `
<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.4; color: #111;">
  <p>Payroll validation has completed for the period listed below.</p>

  <div style="margin: 10px 0 14px 0;">
    <div><strong>Period:</strong> ${periodStart} to ${periodEnd}</div>
    <div><strong>Client/Location:</strong> ${clientLocation}</div>
  </div>

  <div style="margin: 12px 0 18px 0;">
    <a href="${approveUrl}"
       style="display: inline-block; padding: 10px 14px; margin: 6px 10px 6px 0;
              text-decoration: none; border-radius: 6px; border: 1px solid #111;
              font-family: Arial, sans-serif; font-size: 14px; color: #111;">
      APPROVE PAYROLL
    </a>

    <a href="${rerunUrl}"
       style="display: inline-block; padding: 10px 14px; margin: 6px 10px 6px 0;
              text-decoration: none; border-radius: 6px; border: 1px solid #111;
              font-family: Arial, sans-serif; font-size: 14px; color: #111;">
      RERUN AUDIT
    </a>
  </div>

  <h3>Audit Findings</h3>
  <p>If you have questions, reply to this email.</p>
</div>
`.trim();

  const text = [
    "Payroll validation has completed for the period listed below.",
    `Period: ${periodStart} to ${periodEnd}`,
    `Client/Location: ${clientLocation}`,
    "",
    "Actions:",
    `APPROVE PAYROLL: ${approveUrl}`,
    `RERUN AUDIT: ${rerunUrl}`,
    "",
    "Audit Findings",
    "",
    "If you have questions, reply to this email.",
  ].join("\n");

  return { subject, html, text };
}

module.exports = { composeOutcomeEmail, composeEmail: composeOutcomeEmail };
