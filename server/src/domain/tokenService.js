const crypto = require('crypto');

function issueToken({ runId = null, periodStart = null, periodEnd = null, action, recipientEmail = null, ttlMinutes = 60 }) {
  if (!action) throw new Error('action required');
  const tokenId = crypto.randomBytes(12).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMinutes * 60000);
  return {
    token_id: tokenId,
    run_id: runId,
    period_start: periodStart,
    period_end: periodEnd,
    action,
    recipient_email: recipientEmail,
    expires_at: expiresAt,
    status: 'issued',
  };
}

function validateToken(token, now = new Date()) {
  if (!token) return { valid: false, reason: 'missing' };
  if (token.status !== 'issued') return { valid: false, reason: `status:${token.status}` };
  if (token.expires_at <= now) return { valid: false, reason: 'expired' };
  return { valid: true };
}

function markTokenClicked(token) {
  token.status = 'consumed';
  token.clicked_at = new Date();
  return token;
}

module.exports = { issueToken, validateToken, markTokenClicked };
