// server/src/domain/excludedStaffDb.js
// Postgres persistence for Excluded Staff (global ingress filter foundation)

const db = require('./db');

function normalizeDateOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Expect YYYY-MM-DD from UI
  return s;
}

function normalizeTextOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function normalizeBoolean(v, defaultValue) {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === '0') return false;
  return defaultValue;
}

async function listExcludedStaffByLocation(locationName) {
  const { rows } = await db.query(
    `
    SELECT
      id,
      location_name,
      toast_employee_id,
      employee_name,
      reason,
      effective_from,
      effective_to,
      notes,
      active,
      created_at,
      updated_at
    FROM excluded_staff
    WHERE location_name = $1
    ORDER BY employee_name NULLS LAST, toast_employee_id, id
    `,
    [locationName]
  );

  return rows;
}

async function createExcludedStaff(input) {
  const locationName = String(input.location_name || '').trim();
  const toastEmployeeId = String(input.toast_employee_id || '').trim();
  const employeeName = normalizeTextOrNull(input.employee_name);
  const reason = String(input.reason || '').trim();
  const effectiveFrom = normalizeDateOrNull(input.effective_from);
  const effectiveTo = normalizeDateOrNull(input.effective_to);
  const notes = normalizeTextOrNull(input.notes);
  const active = normalizeBoolean(input.active, true);

  if (!locationName) throw new Error('location_name_required');
  if (!toastEmployeeId) throw new Error('toast_employee_id_required');
  if (!reason) throw new Error('reason_required');

  const { rows } = await db.query(
    `
    INSERT INTO excluded_staff (
      location_name,
      toast_employee_id,
      employee_name,
      reason,
      effective_from,
      effective_to,
      notes,
      active,
      created_at,
      updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
    RETURNING
      id,
      location_name,
      toast_employee_id,
      employee_name,
      reason,
      effective_from,
      effective_to,
      notes,
      active,
      created_at,
      updated_at
    `,
    [
      locationName,
      toastEmployeeId,
      employeeName,
      reason,
      effectiveFrom,
      effectiveTo,
      notes,
      active,
    ]
  );

  return rows[0];
}

async function updateExcludedStaffById(id, patch) {
  const rowId = Number(id);
  if (!rowId || Number.isNaN(rowId)) throw new Error('id_invalid');

  // toast_employee_id is intentionally NOT updatable (read-only once saved)
  // location_name is also treated as non-editable here to avoid moving rows across locations by mistake

  const employeeName = patch.employee_name === undefined ? undefined : normalizeTextOrNull(patch.employee_name);
  const reason = patch.reason === undefined ? undefined : String(patch.reason || '').trim();
  const effectiveFrom = patch.effective_from === undefined ? undefined : normalizeDateOrNull(patch.effective_from);
  const effectiveTo = patch.effective_to === undefined ? undefined : normalizeDateOrNull(patch.effective_to);
  const notes = patch.notes === undefined ? undefined : normalizeTextOrNull(patch.notes);
  const active = patch.active === undefined ? undefined : normalizeBoolean(patch.active, true);

  const fields = [];
  const values = [];
  let n = 1;

  if (employeeName !== undefined) {
    fields.push(`employee_name = $${n++}`);
    values.push(employeeName);
  }

  if (reason !== undefined) {
    if (!reason) throw new Error('reason_required');
    fields.push(`reason = $${n++}`);
    values.push(reason);
  }

  if (effectiveFrom !== undefined) {
    fields.push(`effective_from = $${n++}`);
    values.push(effectiveFrom);
  }

  if (effectiveTo !== undefined) {
    fields.push(`effective_to = $${n++}`);
    values.push(effectiveTo);
  }

  if (notes !== undefined) {
    fields.push(`notes = $${n++}`);
    values.push(notes);
  }

  if (active !== undefined) {
    fields.push(`active = $${n++}`);
    values.push(active);
  }

  if (fields.length === 0) {
    const { rows } = await db.query(
      `
      SELECT
        id,
        location_name,
        toast_employee_id,
        employee_name,
        reason,
        effective_from,
        effective_to,
        notes,
        active,
        created_at,
        updated_at
      FROM excluded_staff
      WHERE id = $1
      `,
      [rowId]
    );
    return rows[0] || null;
  }

  values.push(rowId);

  const { rows } = await db.query(
    `
    UPDATE excluded_staff
    SET ${fields.join(', ')}, updated_at = NOW()
    WHERE id = $${n}
    RETURNING
      id,
      location_name,
      toast_employee_id,
      employee_name,
      reason,
      effective_from,
      effective_to,
      notes,
      active,
      created_at,
      updated_at
    `,
    values
  );

  return rows[0] || null;
}

async function softDeleteExcludedStaffById(id) {
  const rowId = Number(id);
  if (!rowId || Number.isNaN(rowId)) throw new Error('id_invalid');

  const { rows } = await db.query(
    `
    UPDATE excluded_staff
    SET active = FALSE, updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      location_name,
      toast_employee_id,
      employee_name,
      reason,
      effective_from,
      effective_to,
      notes,
      active,
      created_at,
      updated_at
    `,
    [rowId]
  );

  return rows[0] || null;
}

module.exports = {
  listExcludedStaffByLocation,
  createExcludedStaff,
  updateExcludedStaffById,
  softDeleteExcludedStaffById,
};
