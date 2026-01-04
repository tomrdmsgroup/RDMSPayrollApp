/**
 * Postmark email provider (API based, no SMTP).
 *
 * Env:
 *   POSTMARK_SERVER_TOKEN (required)
 *   POSTMARK_MESSAGE_STREAM (optional) default: "outbound"
 */

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing_env_${name}`);
  return v;
}

function normalizeTo(to) {
  if (Array.isArray(to)) return to.filter(Boolean).join(', ');
  return String(to || '').trim();
}

function normalizeString(v) {
  return v === null || v === undefined ? '' : String(v);
}

async function postmarkSendEmail({
  from,
  to,
  subject,
  html,
  text,
  replyTo,
}) {
  const token = requireEnv('POSTMARK_SERVER_TOKEN');
  const messageStream = process.env.POSTMARK_MESSAGE_STREAM || 'outbound';

  const payload = {
    From: normalizeString(from),
    To: normalizeTo(to),
    Subject: normalizeString(subject),
    MessageStream: messageStream,
  };

  if (replyTo) payload.ReplyTo = normalizeString(replyTo);
  if (html) payload.HtmlBody = normalizeString(html);
  if (text) payload.TextBody = normalizeString(text);

  if (!payload.From) throw new Error('missing_from');
  if (!payload.To) throw new Error('missing_to');
  if (!payload.Subject) throw new Error('missing_subject');
  if (!payload.HtmlBody && !payload.TextBody) throw new Error('missing_body');

  const controller = new AbortController();
  const timeoutMs = 15000;
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': token,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const message = data && (data.Message || data.ErrorCode)
        ? `postmark_error_${normalizeString(data.ErrorCode)}_${normalizeString(data.Message)}`
        : `postmark_http_${resp.status}`;
      const err = new Error(message);
      err.details = data;
      throw err;
    }

    return {
      ok: true,
      provider: 'postmark',
      provider_message_id: data.MessageID || null,
    };
  } finally {
    clearTimeout(t);
  }
}

async function sendEmail({ from, to, subject, html, text, replyTo }) {
  return postmarkSendEmail({ from, to, subject, html, text, replyTo });
}

module.exports = {
  sendEmail,
};
