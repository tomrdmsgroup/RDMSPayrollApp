// server/src/domain/authService.js

const crypto = require('crypto');
const { query } = require('./db');

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function getUserByEmail(email) {
  const e = (email || '').trim().toLowerCase();
  if (!e) return null;

  const { rows } = await query(
    `SELECT email, role, status FROM staff_users WHERE email = $1`,
    [e],
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (row.status !== 'active') return null;

  return { email: row.email, role: row.role };
}

async function upsertStaffUserAsAdminOnly(actorEmail, targetEmail, role) {
  const actor = await getUserByEmail(actorEmail);
  if (!actor || actor.role !== 'admin') throw new Error('forbidden_admin_only');

  const e = (targetEmail || '').trim().toLowerCase();
  if (!e) throw new Error('email_required');
  if (role !== 'admin' && role !== 'staff') throw new Error('invalid_role');

  await query(
    `
    INSERT INTO staff_users (email, role, status)
    VALUES ($1, $2, 'active')
    ON CONFLICT (email) DO UPDATE SET
      role = EXCLUDED.role,
      status = 'active',
      updated_at = NOW()
    `,
    [e, role],
  );

  return getUserByEmail(e);
}

async function disableStaffUserAsAdminOnly(actorEmail, targetEmail) {
  const actor = await getUserByEmail(actorEmail);
  if (!actor || actor.role !== 'admin') throw new Error('forbidden_admin_only');

  const e = (targetEmail || '').trim().toLowerCase();
  if (!e) throw new Error('email_required');

  await query(
    `
    UPDATE staff_users
    SET status = 'disabled', updated_at = NOW()
    WHERE email = $1
    `,
    [e],
  );

  return true;
}

async function listStaffUsersAsAdminOnly(actorEmail) {
  const actor = await getUserByEmail(actorEmail);
  if (!actor || actor.role !== 'admin') throw new Error('forbidden_admin_only');

  const { rows } = await query(
    `SELECT email, role, status, created_at, updated_at FROM staff_users ORDER BY email ASC`,
    [],
  );
  return rows;
}

async function createSessionForEmail(email) {
  const user = await getUserByEmail(email);
  if (!user) return null;

  const token = randomToken();
  const expiresAt = addDays(new Date(), 7); // 7 days

  await query(
    `
    INSERT INTO staff_sessions (token, user_email, expires_at)
    VALUES ($1, $2, $3)
    `,
    [token, user.email, expiresAt.toISOString()],
  );

  return { token, user, expiresAt };
}

async function getUserBySessionToken(token) {
  const t = (token || '').trim();
  if (!t) return null;

  const { rows } = await query(
    `
    SELECT s.token, s.expires_at, u.email, u.role, u.status
    FROM staff_sessions s
    JOIN staff_users u ON u.email = s.user_email
    WHERE s.token = $1
    `,
    [t],
  );

  if (!rows.length) return null;

  const row = rows[0];
  const expiresAt = new Date(row.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    await query(`DELETE FROM staff_sessions WHERE token = $1`, [t]);
    return null;
  }

  if (row.status !== 'active') return null;

  return { email: row.email, role: row.role };
}

async function deleteSessionToken(token) {
  const t = (token || '').trim();
  if (!t) return;
  await query(`DELETE FROM staff_sessions WHERE token = $1`, [t]);
}

module.exports = {
  getUserByEmail,
  upsertStaffUserAsAdminOnly,
  disableStaffUserAsAdminOnly,
  listStaffUsersAsAdminOnly,
  createSessionForEmail,
  getUserBySessionToken,
  deleteSessionToken,
};
