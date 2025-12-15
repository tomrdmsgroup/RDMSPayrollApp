let nodemailer;

function loadNodemailer() {
  if (nodemailer) return nodemailer;
  try {
    // Prefer real nodemailer when installed
    // eslint-disable-next-line global-require
    nodemailer = require('nodemailer');
  } catch (err) {
    // Fallback stub keeps the module usable in restricted environments
    nodemailer = require('../vendor/nodemailerFallback');
  }
  return nodemailer;
}

let cachedTransporter = null;

function buildTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host) throw new Error('smtp_host_missing');
  const nm = loadNodemailer();
  cachedTransporter = nm.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true',
    auth: user && pass ? { user, pass } : undefined,
  }, {
    from: process.env.SMTP_FROM || user,
  });
  return cachedTransporter;
}

async function sendEmail({ to, subject, body, attachments = [] }) {
  if (!to || !subject || !body) throw new Error('email_fields_missing');
  const transporter = buildTransporter();
  try {
    const info = await transporter.sendMail({ to, subject, text: body, attachments });
    return { id: info && info.messageId ? info.messageId : `email-${Date.now()}`, to, subject };
  } catch (err) {
    throw new Error(`email_send_failed:${err.message}`);
  }
}

function resetTransporter() {
  cachedTransporter = null;
  nodemailer = null;
}

module.exports = { sendEmail, buildTransporter, loadNodemailer, resetTransporter };
