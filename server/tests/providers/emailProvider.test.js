const assert = require('assert');
const Module = require('module');

async function withMockNodemailer(mock, fn) {
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'nodemailer') return mock;
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[require.resolve('../../src/providers/emailProvider')];
  try {
    await fn();
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve('../../src/providers/emailProvider')];
  }
}

async function testEmailProviderUsesSmtpSettings() {
  const sent = [];
  const mock = {
    createTransport: (opts, defaults) => {
      sent.push({ opts, defaults });
      return {
        async sendMail(mail) {
          sent.push({ mail });
          return { messageId: 'mocked' };
        },
      };
    },
  };
  process.env.SMTP_HOST = 'smtp.test';
  process.env.SMTP_PORT = '2525';
  process.env.SMTP_USER = 'user';
  process.env.SMTP_PASS = 'pass';
  process.env.SMTP_FROM = 'from@example.com';
  await withMockNodemailer(mock, async () => {
    const { sendEmail, resetTransporter } = require('../../src/providers/emailProvider');
    const response = await sendEmail({ to: 'ops@example.com', subject: 'Test', body: 'Body' });
    assert.equal(response.id, 'mocked', 'should return mocked message id');
    assert.equal(sent[0].opts.host, 'smtp.test');
    assert.equal(sent[1].mail.to, 'ops@example.com');
    resetTransporter();
  });
}

module.exports = { testEmailProviderUsesSmtpSettings };
