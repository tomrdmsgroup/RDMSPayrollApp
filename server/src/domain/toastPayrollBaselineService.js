const { query } = require('./db');

function safeTrim(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

function toNum(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[$,]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeHeader(header) {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseCsv(text) {
  const input = String(text || '');
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        value += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(value);
      value = '';
      continue;
    }
    if (ch === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }
    if (ch === '\r') continue;
    value += ch;
  }

  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }

  if (!rows.length) return { headers: [], rows: [] };

  const rawHeaders = rows[0].map((h) => String(h || '').trim());
  const headers = rawHeaders.map((h, idx) => (h ? h : `column_${idx + 1}`));
  const bodyRows = rows.slice(1).filter((r) => r.some((cell) => String(cell || '').trim() !== ''));

  const objects = bodyRows.map((r) => {
    const out = {};
    headers.forEach((h, idx) => {
      out[h] = r[idx] !== undefined ? r[idx] : '';
    });
    return out;
  });

  return { headers, rows: objects };
}

function pickByAliases(row, aliases) {
  const map = new Map(Object.keys(row || {}).map((k) => [normalizeHeader(k), row[k]]));
  for (const alias of aliases) {
    const v = map.get(alias);
    const t = safeTrim(v);
    if (t !== null) return t;
  }
  return null;
}

function normalizeUploadedRow(row, context) {
  const toastEmployeeId = pickByAliases(row, ['toast_employee_id', 'toast_employee_guid', 'employee_guid', 'employee_uuid']);
  const employeeId = pickByAliases(row, [
    'employee_id',
    'payroll_employee_id',
    'external_employee_id',
    'employee_number',
    'employee_no',
    'payroll_id',
  ]);
  const employeeName = pickByAliases(row, ['employee', 'employee_name', 'team_member']);
  const jobTitle = pickByAliases(row, ['job_title', 'job', 'job_name']);
  const locationName = pickByAliases(row, ['location', 'location_name']) || context.location_name;
  const locationCode = pickByAliases(row, ['location_code', 'restaurant_guid', 'location_id']);

  return {
    location_name: context.location_name,
    pay_period_start: context.period_start,
    pay_period_end: context.period_end,
    toast_employee_id: toastEmployeeId,
    employee_id: employeeId,
    employee_name: employeeName,
    job_title: jobTitle,
    location: locationName,
    location_code: locationCode,
    regular_hours: toNum(pickByAliases(row, ['regular_hours', 'reg_hours'])),
    overtime_hours: toNum(pickByAliases(row, ['overtime_hours', 'ot_hours'])),
    total_pay: toNum(pickByAliases(row, ['total_pay', 'gross_pay', 'gross'])),
    source: 'uploaded_csv_baseline',
  };
}

function normalizeApiRow(row, context) {
  return {
    location_name: context.location_name,
    pay_period_start: context.period_start,
    pay_period_end: context.period_end,
    toast_employee_id: safeTrim(row['Toast Employee ID']),
    employee_id: safeTrim(row['Employee ID']),
    employee_name: safeTrim(row.Employee),
    job_title: safeTrim(row['Job Title']),
    location: safeTrim(row.Location) || context.location_name,
    location_code: safeTrim(row['Location Code']),
    regular_hours: toNum(row['Regular Hours']),
    overtime_hours: toNum(row['Overtime Hours']),
    total_pay: toNum(row['Total Pay']),
    source: 'api_derived_original',
  };
}

function keyPart(v, fallback) {
  const x = safeTrim(v);
  if (!x) return fallback;
  return x.toLowerCase();
}

function buildStableKey(normalizedRow) {
  const person = keyPart(
    normalizedRow.employee_id,
    keyPart(normalizedRow.employee_name, keyPart(normalizedRow.toast_employee_id, '__unknown_person__'))
  );
  const job = keyPart(normalizedRow.job_title, '__unknown_job__');
  const location = keyPart(normalizedRow.location_code, keyPart(normalizedRow.location, '__unknown_location__'));
  return [person, job, location, normalizedRow.pay_period_start, normalizedRow.pay_period_end].join('|||');
}

function compareRows(apiRows, csvRows) {
  const apiNorm = (Array.isArray(apiRows) ? apiRows : []).map((row) => ({ ...row, stable_key: buildStableKey(row) }));
  const csvNorm = (Array.isArray(csvRows) ? csvRows : []).map((row) => ({ ...row, stable_key: buildStableKey(row) }));

  const apiMap = new Map(apiNorm.map((row) => [row.stable_key, row]));
  const csvMap = new Map(csvNorm.map((row) => [row.stable_key, row]));

  const onlyInApi = [];
  const onlyInCsv = [];
  const mismatches = [];

  for (const [key, apiRow] of apiMap.entries()) {
    const csvRow = csvMap.get(key);
    if (!csvRow) {
      onlyInApi.push(apiRow);
      continue;
    }
    const diffs = [];
    ['employee_name', 'job_title', 'location', 'regular_hours', 'overtime_hours', 'total_pay'].forEach((field) => {
      const left = apiRow[field];
      const right = csvRow[field];
      if (left === null && right === null) return;
      if (typeof left === 'number' || typeof right === 'number') {
        const l = toNum(left);
        const r = toNum(right);
        if (l === null && r === null) return;
        if (l === null || r === null || Math.abs(l - r) > 0.01) diffs.push({ field, api_value: left, csv_value: right });
        return;
      }
      if (String(left || '') !== String(right || '')) {
        diffs.push({ field, api_value: left, csv_value: right });
      }
    });
    if (diffs.length) mismatches.push({ stable_key: key, diffs, api_row: apiRow, csv_row: csvRow });
  }

  for (const [key, csvRow] of csvMap.entries()) {
    if (!apiMap.has(key)) onlyInCsv.push(csvRow);
  }

  return {
    summary: {
      api_row_count: apiNorm.length,
      csv_row_count: csvNorm.length,
      row_count_delta: apiNorm.length - csvNorm.length,
      missing_in_csv_count: onlyInApi.length,
      missing_in_api_count: onlyInCsv.length,
      mismatch_count: mismatches.length,
    },
    missing_in_csv: onlyInApi,
    missing_in_api: onlyInCsv,
    column_mismatches: mismatches,
  };
}

async function saveUploadedBaseline({ locationName, periodStart, periodEnd, uploadedBy, fileName, rawCsv, csvRows }) {
  const insertUpload = await query(
    `
      INSERT INTO toast_payroll_baseline_uploads
      (location_name, period_start, period_end, uploaded_by, file_name, raw_csv, raw_row_count, normalized_row_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, location_name, period_start, period_end, uploaded_by, uploaded_at, file_name, raw_row_count, normalized_row_count
    `,
    [locationName, periodStart, periodEnd, uploadedBy, fileName || null, rawCsv, csvRows.length, csvRows.length],
  );

  const upload = insertUpload.rows[0];
  for (let i = 0; i < csvRows.length; i += 1) {
    const row = csvRows[i];
    await query(
      `
        INSERT INTO toast_payroll_baseline_rows
        (upload_id, row_index, stable_key, normalized_row, raw_row)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)
      `,
      [upload.id, i + 1, row.stable_key, JSON.stringify(row.normalized), JSON.stringify(row.raw)],
    );
  }

  return upload;
}

async function getLatestBaseline({ locationName, periodStart, periodEnd }) {
  const uploadResp = await query(
    `
      SELECT id, location_name, period_start, period_end, uploaded_by, uploaded_at, file_name,
             raw_csv, raw_row_count, normalized_row_count
      FROM toast_payroll_baseline_uploads
      WHERE location_name = $1 AND period_start = $2 AND period_end = $3
      ORDER BY uploaded_at DESC, id DESC
      LIMIT 1
    `,
    [locationName, periodStart, periodEnd],
  );
  const upload = uploadResp.rows[0] || null;
  if (!upload) return null;

  const rowsResp = await query(
    `
      SELECT row_index, stable_key, normalized_row, raw_row
      FROM toast_payroll_baseline_rows
      WHERE upload_id = $1
      ORDER BY row_index ASC
    `,
    [upload.id],
  );

  return {
    upload,
    rows: rowsResp.rows.map((row) => ({
      row_index: row.row_index,
      stable_key: row.stable_key,
      normalized: row.normalized_row,
      raw: row.raw_row,
    })),
  };
}

module.exports = {
  parseCsv,
  normalizeUploadedRow,
  normalizeApiRow,
  buildStableKey,
  compareRows,
  saveUploadedBaseline,
  getLatestBaseline,
};
