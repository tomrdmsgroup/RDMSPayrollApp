// Manual smoke test for SMTP email delivery.
// Usage: populate SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, and TARGET_EMAIL in the environment, then run:
//   node scripts/emailSmoke.js

const { sendEmail, resetTransporter } = require('../src/providers/emailProvider');

async function run() {
  try {
    const target = process.env.TARGET_EMAIL;
    if (!target) throw new Error('TARGET_EMAIL missing');
    const result = await sendEmail({
      to: target,
      subject: 'RDMS Payroll SMTP smoke test',
      body: 'If you received this, SMTP credentials are working.',
    });
    console.log('Email sent', result);
  } catch (err) {
    console.error('Smoke test failed', err.message || err);
  } finally {
    resetTransporter();
  }
}

run();
