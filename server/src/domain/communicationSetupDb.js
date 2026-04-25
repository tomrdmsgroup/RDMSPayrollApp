const db = require('./db');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function listCommunicationRecipientSettings(locationName) {
  const { rows } = await db.query(
    `SELECT email, send_validation_email, updated_at, updated_by
     FROM ops_validation_email_recipients
     WHERE location_name = $1`,
    [locationName]
  );

  const byEmail = {};
  rows.forEach((row) => {
    const key = normalizeEmail(row.email);
    if (!key) return;
    byEmail[key] = {
      email: key,
      send_validation_email: row.send_validation_email === true,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updated_by: row.updated_by || null,
    };
  });

  return byEmail;
}

async function upsertCommunicationRecipientSetting({ locationName, email, sendValidationEmail, updatedBy }) {
  // TODO: Future validation email sending should target only recipients with send_validation_email=true.
  // TODO: Future Confirm Validation handling should feed payroll dashboard validated status updates.
  const normalizedEmail = normalizeEmail(email);
  if (!locationName) throw new Error('location_name_required');
  if (!normalizedEmail) throw new Error('email_required');

  await db.query(
    `INSERT INTO ops_validation_email_recipients (
      location_name,
      email,
      send_validation_email,
      updated_by,
      updated_at
    ) VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (location_name, email)
    DO UPDATE SET
      send_validation_email = EXCLUDED.send_validation_email,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()`,
    [locationName, normalizedEmail, sendValidationEmail === true, updatedBy || null]
  );

  const { rows } = await db.query(
    `SELECT email, send_validation_email, updated_at, updated_by
     FROM ops_validation_email_recipients
     WHERE location_name = $1 AND email = $2`,
    [locationName, normalizedEmail]
  );

  const row = rows[0] || {};
  return {
    email: row.email || normalizedEmail,
    send_validation_email: row.send_validation_email === true,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    updated_by: row.updated_by || null,
  };
}

module.exports = {
  listCommunicationRecipientSettings,
  upsertCommunicationRecipientSetting,
};
