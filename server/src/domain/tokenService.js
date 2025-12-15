const crypto = require('crypto');

// Module-scope token store to persist across requests
const tokenStore = new Map();

function issueToken({ runId = null, periodStart = null, periodEnd = null, action, ttlMinutes = 60 }) {
  if (!action) throw new Error('action required');

  const tokenId = crypto.randomBytes(12).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  const token = {
    token_id: tokenId,
    run_id: runId,
    period_start: periodStart,
    period_end: periodEnd,
    action,
    expires_at: expiresAt,
    issued_at: new Date(),
    status: 'issued',
    click_count: 0,
  };

  tokenStore.set(tokenId, token);
  return token;
}

function getToken(tokenId) {
  if (!tokenId) return null;
  return tokenStore.get(tokenId) || null;
}

function validateToken(tokenOrId, now = new Date()) {
  const token = typeof tokenOrId === 'string' ? getToken(tokenOrId) : tokenOrId;
  if (!token) return { valid: false, reason: 'missing' };
  if (token.status !== 'issued') return { valid: false, reason: `status:${token.status}` };
  if (token.expires_at <= now) return { valid: false, reason: 'expired' };
  return { valid: true, token };
}

function markTokenClicked(tokenOrId) {
  const token = typeof tokenOrId === 'string' ? getToken(tokenOrId) : tokenOrId;
  if (!token) return null;
  token.click_count = (token.click_count || 0) + 1;
  token.clicked_at = new Date();
  if (token.status === 'issued') token.status = 'consumed';
  tokenStore.set(token.token_id, token);
  return token;
}

function listTokens() {
  return Array.from(tokenStore.values());
}

function clearTokens() {
  tokenStore.clear();
}

module.exports = {
  issueToken,
  getToken,
  validateToken,
  markTokenClicked,
  listTokens,
  clearTokens,
  tokenStore,
};
