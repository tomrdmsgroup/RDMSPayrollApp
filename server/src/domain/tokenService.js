// server/src/domain/tokenService.js

const crypto = require('crypto');
const { query } = require('./db');

function nowIso() {
  return new Date().toISOString();
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function createToken({ run_id, type = 'approval', ttl_seconds = 60 * 60 * 24 * 7, meta = null } = {}) {
  if (!run_id) return null;

  const token = randomToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + Number(ttl_seconds) * 1000).toISOString();

  const row = {
    token,
    run_id: Number(run_id),
    type,
    created_at: createdAt,
    expires_at: expiresAt,
    used_at: null,
    meta,
  };

  await query(
    `INSERT INTO ops_tokens (token, token_row, created_at, updated_at) VALUES ($1, $2::jsonb, NOW(), NOW())`,
    [token, row],
  );

  return row;
}

async function getToken(token) {
  if (!token) return null;
  const r = await query(`SELECT token_row FROM ops_tokens WHERE token = $1`, [token]);
  if (!r.rows.length) return null;
  return r.rows[0].token_row || null;
}

function isExpired(tokenRow) {
  if (!tokenRow?.expires_at) return false;
  return Date.now() > new Date(tokenRow.expires_at).getTime();
}

async function markTokenUsed(token) {
  const row = await getToken(token);
  if (!row) return null;

  row.used_at = nowIso();

  await query(`UPDATE ops_tokens SET token_row = $1::jsonb, updated_at = NOW() WHERE token = $2`, [row, token]);
  return row;
}

async function validateToken(token, { type = null, allow_used = false } = {}) {
  const row = await getToken(token);
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
