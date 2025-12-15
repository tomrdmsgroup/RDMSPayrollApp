// Minimal email provider abstraction
function sendEmail({ to, subject, body, attachments = [] }) {
  console.log('EMAIL SEND', { to, subject, attachmentsCount: attachments.length });
  return { id: `email-${Date.now()}`, to, subject };
}

module.exports = { sendEmail };
