const https = require('https');

function postmarkRequest({ token, payload }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.postmarkapp.com',
        path: '/email',
        headers: {
          'X-Postmark-Server-Token': token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 20000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch (_) {
            parsed = { raw: data };
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve(parsed);
          }

          const err = new Error(
            `postmark_error status=${res.statusCode} body=${data || ''}`
          );
          err.statusCode = res.statusCode;
          err.response = parsed;
          return reject(err);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('postmark_timeout'));
    });

    req.on('error', (err) => reject(err));

    req.write(body);
    req.end();
  });
}

async function sendOutcomeEmail(outcome) {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) return { ok: false, error: 'missing_postmark_server_token' };

  const delivery = outcome?.delivery || {};
  const to = Array.isArray(delivery.recipients) ? delivery.recipients : [];
  const from = (delivery.from || '').trim();
  const replyTo = (delivery.reply_to || '').trim();

  if (!to.length) return { ok: false, error: 'missing_recipients' };
  if (!from) return { ok: false, error: 'missing_from' };

  const subject = delivery.subject || 'Payroll validation';
  const html = delivery.rendered_html || '';
  const text = delivery.rendered_text || '';

  const payload = {
    From: from,
    To: to.join(','),
    Subject: subject,
    HtmlBody: html || undefined,
    TextBody: text || undefined,
    ReplyTo: replyTo || undefined,
  };

  // Optional: allow a specific Message Stream name via env if you want it later.
  // Example: POSTMARK_MESSAGE_STREAM="Payroll Validation"
  const stream = (process.env.POSTMARK_MESSAGE_STREAM || '').trim();
  if (stream) payload.MessageStream = stream;

  try {
    const result = await postmarkRequest({ token, payload });

    const providerMessageId =
      result?.MessageID || result?.MessageId || result?.messageID || null;

    return { ok: true, providerMessageId, result };
  } catch (err) {
    return {
      ok: false,
      error: 'postmark_send_failed',
      detail: err?.message || String(err),
    };
  }
}

module.exports = { sendOutcomeEmail };
