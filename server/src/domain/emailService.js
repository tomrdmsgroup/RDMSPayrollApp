// server/src/domain/emailService.js

const nodemailer = require('nodemailer');
const { notifyFailure } = require('./failureService');
const { updateOutcome } = require('./outcomeService');

function nowIso() {
  return new Date().toISOString();
}

function getSmtpConfig() {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    SMTP_FROM,
  } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  return {
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
    defaultFrom: SMTP_FROM || null,
  };
}

function createTransport(config) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  });
}

/**
 * sendOutcomeEmail({ run, outcome })
 *
 * Preconditions:
 * - outcome.delivery.mode === "email"
 * - rendered subject + body exist
 * - recipients exist
 *
 * Idempotent:
 * - if sent_at already set, does nothing
 */
async function sendOutcomeEmail({ run, outcome }) {
  if (!run || !outcome) return { ok: false, error: 'missing_run_or_outcome' };

  const delivery = outcome.delivery || {};

  if (delivery.mode !== 'email') {
    return { ok: false, error: 'delivery_mode_not_email' };
  }

  if (delivery.sent_at) {
    return { ok: true, already_sent: true };
  }

  const recipients = Array.isArray(delivery.recipients) ? delivery.recipients : [];
  if (recipients.length === 0) {
    return { ok: false, error: 'missing_recipients' };
  }

  if (!delivery.subject || (!delivery.rendered_text && !delivery.rendered_html)) {
    return { ok: false, error: 'missing_rendered_content' };
  }

  const smtp = getSmtpConfig();
  if (!smtp) {
    notifyFailure({
      step: 'email_send',
      error: 'smtp_not_configured',
      runId: run.id,
    });
    return { ok: false, error: 'smtp_not_configured' };
  }

  const transporter = createTransport(smtp);

  const mail = {
    from: delivery.from || smtp.defaultFrom,
    to: recipients.join(','),
    replyTo: delivery.reply_to || undefined,
    subject: delivery.subject,
    text: delivery.rendered_text || undefined,
    html: delivery.rendered_html || undefined,
  };

  if (!mail.from) {
    return { ok: false, error: 'missing_from_address' };
  }

  try {
    const info = await transporter.sendMail(mail);

    const updated = updateOutcome(run.id, {
      status: 'delivered',
      delivery: {
        sent_at: nowIso(),
        provider_message_id: info?.messageId || null,
      },
    });

    return {
      ok: true,
      message_id: info?.messageId || null,
      outcome: updated,
    };
  } catch (err) {
    notifyFailure({
      step: 'email_send',
      error: err?.message || 'email_send_failed',
      runId: run.id,
    });

    return { ok: false, error: 'email_send_failed' };
  }
}

module.exports = {
  sendOutcomeEmail,
};
