// server/src/domain/tokenService.js

const crypto = require('crypto');
const { updateStore } = require('./persistenceStore');

function nowIso() {
  return new Date().toISOString();
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function createToken({
  run_id,
  type = 'approval',
  ttl_seconds = 60 * 60 * 24 * 7, // 7 days default
  meta = null,
} = {}) {
  if (!run_id) return null;

  const token = randomToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + Number(ttl_seconds) * 1000).toISOString();

  let created = null;

  updateStore((store) => {
    created = {
      token,
      run_id: Number(run_id),
      type,
      created_at: createdAt,
      expires_at: expiresAt,
      used_at: null,
      meta,
    };

    store.tokens.push(created);
    return store;
  });

  return created;
}

function getToken(token) {
  if (!token) return null;

  let found = null;

  updateStore((store) => {
    found = store.tokens.find((t) => t.token === token) || null;
    return store;
  });

  return found;
}

function isExpired(tokenRow) {
  if (!tokenRow?.expires_at) return false;
  return Date.now() > new Date(tokenRow.expires_at).getTime();
}

function markTokenUsed(token) {
  if (!token) return null;

  let updated = null;

  updateStore((store) => {
    const row = store.tokens.find((t) => t.token === token);
    if (!row) {
      updated = null;
      return store;
    }
    row.used_at = nowIso();
    updated = row;
    return store;
  });

  return updated;
}

function validateToken(token, { type = null, allow_used = false } = {}) {
  const row = getToken(token);
  if (!row) return { ok: false, reason: 'token_not_found' };
  if (type && row.type !== type) return { ok: false, reason: 'token_wrong_type' };
  if (!allow_used && row.used_at) return { ok: false, reason: 'token_used' };
  if (isExpired(row)) return { ok: false, reason: 'token_expired' };
  return { ok: true, token: row };
}

module.exports = {
  createToken,
  getToken,
  markTokenUsed,
  validateToken,
  isExpired,
};
