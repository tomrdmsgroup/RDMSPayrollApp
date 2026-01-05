// server/src/domain/airtableRecapService.js

const fetch = require('node-fetch');

function requireEnv(key) {
  const v = (process.env[key] || '').trim();
  if (!v) throw new Error(`missing_${key}`);
  return v;
}

function airtableBaseUrl() {
  const base = requireEnv('AIRTABLE_VITALS_BASE');
  return `https://api.airtable.com/v0/${base}`;
}

function airtableAuthHeader() {
  const token = requireEnv('AIRTABLE_VITALS_API_KEY');
  return { Authorization: `Bearer ${token}` };
}

function escapeAirtableString(v) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function airtableListAll({ table, filterByFormula, fields }) {
  const urlBase = airtableBaseUrl();
  const headers = { ...airtableAuthHeader(), 'Content-Type': 'application/json' };

  let offset = null;
  const out = [];

  for (;;) {
    const params = new URLSearchParams();
    if (filterByFormula) params.set('filterByFormula', filterByFormula);
    if (offset) params.set('offset', offset);
    if (Array.isArray(fields) && fields.length) {
      fields.forEach((f) => params.append('fields[]', f));
    }

    const url = `${urlBase}/${encodeURIComponent(table)}?${params.toString()}`;
    const resp = await fetch(url, { method: 'GET', headers });
    const body = await resp.json();

    if (!resp.ok) throw new Error(`airtable_list_failed:${resp.status}`);

    (body.records || []).forEach((r) => out.push(r));
    offset = body.offset || null;
    if (!offset) break;
  }

  return out;
}

function parseTime12h(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;

  let hh = Number(m[1]);
  const mm = Number(m[2] || '0');
  const ap = m[3].toUpperCase();

  if (hh < 1 || hh > 12) return null;
  if (mm < 0 || mm > 59) return null;

  if (ap === 'AM') {
    if (hh === 12) hh = 0;
  } else {
    if (hh !== 12) hh += 12;
  }

  return { hh, mm };
}

function toYmd(dateLike) {
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDaysYmd(ymd, days) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return toYmd(dt.toISOString());
}

function localPartsFromUtcDate(utcDate, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = fmt.formatToParts(utcDate);
  const get = (type) => parts.find((p) => p.type === type)?.value;

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

function zonedLocalToUtc({ y, m, d, hh, mm, ss = 0, timeZone }) {
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  const p1 = localPartsFromUtcDate(guess, timeZone);
  const desired = Date.UTC(y, m - 1, d, hh, mm, ss);
  const got = Date.UTC(p1.year, p1.month - 1, p1.day, p1.hour, p1.minute, p1.second);
  guess = new Date(guess.getTime() + (desired - got));

  const p2 = localPartsFromUtcDate(guess, timeZone);
  const got2 = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second);
  return new Date(guess.getTime() + (desired - got2));
}

function formatLocalCutoff({ cutoffUtcIso, timeZone }) {
  if (!cutoffUtcIso) return null;
  const d = new Date(cutoffUtcIso);
  if (Number.isNaN(d.getTime())) return null;

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const tzShort = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value;

  return `${fmt.format(d)}${tzShort ? ` (${tzShort})` : ''}`;
}

function computeValidationCutoffUtc({ validationDateYmd, endTimeNextDay, timeZone }) {
  const tz = String(timeZone || '').trim() || 'UTC';
  const nextDayYmd = addDaysYmd(validationDateYmd, 1);
  if (!nextDayYmd) return null;

  const time = parseTime12h(endTimeNextDay) || { hh: 0, mm: 0 };
  const m = nextDayYmd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;

  return zonedLocalToUtc({
    y: Number(m[1]),
    m: Number(m[2]),
    d: Number(m[3]),
    hh: time.hh,
    mm: time.mm,
    ss: 0,
    timeZone: tz,
  });
}

function findCurrentPeriodRow(rows, nowUtc) {
  const now = nowUtc || new Date();
  const candidates = rows
    .map((r) => ({
      record_id: r.id,
      fields: r.fields || {},
      start: new Date(r.fields['PR Period Start Date']),
      submit: new Date(r.fields['PR Period Submit Date']),
    }))
    .filter((x) => !Number.isNaN(x.start.getTime()) && !Number.isNaN(x.submit.getTime()))
    .filter((x) => now.getTime() >= x.start.getTime() && now.getTime() <= x.submit.getTime());

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.start.getTime() - a.start.getTime());
  return candidates[0];
}

function normalizePreviewRecipients(vitals) {
  const emails = [];
  for (let i = 1; i <= 5; i++) {
    const v = (vitals[`Payroll Preview ${i} Email`] || '').toString().trim();
    if (v) emails.push(v);
  }
  const count = emails.length;
  let summary = '';
  if (count === 0) summary = 'None configured';
  else if (count === 1) summary = emails[0];
  else summary = `${emails[0]} +${count - 1}`;
  return { emails, count, summary };
}

async function listLocationNames() {
  const vitalsTable = requireEnv('AIRTABLE_VITALS_TABLE');
  const locationField = requireEnv('AIRTABLE_VITALS_LOCATION_FIELD');

  const recs = await airtableListAll({
    table: vitalsTable,
    fields: [locationField],
  });

  const names = recs
    .map((r) => (r.fields || {})[locationField])
    .map((v) => (v || '').toString().trim())
    .filter(Boolean);

  names.sort((a, b) => a.localeCompare(b));
  return names;
}

async function getRecapForLocationName(locationName) {
  const vitalsTable = requireEnv('AIRTABLE_VITALS_TABLE');
  const locationField = requireEnv('AIRTABLE_VITALS_LOCATION_FIELD');
  const payrollDetailsTable = requireEnv('AIRTABLE_PAYROLL_CALENDAR_DETAILS_TABLE');

  const name = String(locationName || '').trim();
  if (!name) throw new Error('location_name_required');

  const filterVitals = `{${locationField}}='${escapeAirtableString(name)}'`;
  const vitalsRecords = await airtableListAll({ table: vitalsTable, filterByFormula: filterVitals });
  if (!vitalsRecords.length) throw new Error('location_not_found');

  const vitals = vitalsRecords[0].fields || {};

  const calendarName =
    vitals['Payroll Calendar (from PR Calendar)'] ||
    vitals['Payroll Calendar'] ||
    vitals['PR Calendar Name'] ||
    null;

  if (!calendarName) throw new Error('missing_payroll_calendar_name');

  const timeZone = (vitals['Time Zone'] || '').toString().trim();
  if (!timeZone) throw new Error('invalid_time_zone');

  const validationEndTimeNextDay = (vitals['Validation End Time (Next Day)'] || '').toString().trim();
  const appActive = vitals['PR Validation APP Active?'] === true;

  const preview = normalizePreviewRecipients(vitals);

  const asanaProjectGuid = (vitals['PR Asana Project GUID'] || '').toString().trim();
  const asanaInboxGuid = (vitals['PR Asana Inbox Section GUID'] || '').toString().trim();
  const asanaConnected = !!(asanaProjectGuid && asanaInboxGuid);

  const payrollCompany = (vitals['Payroll Company'] || '').toString().trim();
  const posType = (vitals['POS Type'] || '').toString().trim();
  const payrollProjectEmail = (vitals['PR RDMS Payroll Project Email Address'] || '').toString().trim();
  const tipReportType = (vitals['PR Tip Report Type'] || '').toString().trim();
  const payrollCompanyCode = (vitals['PR Company Code (for UPload)'] || '').toString().trim();
  const payFrequency = (vitals['PR Pay Frequency for Upload'] || '').toString().trim();

  const filterDetails = `{PR Calendar Name - Master}='${escapeAirtableString(calendarName)}'`;
  const detailRecords = await airtableListAll({ table: payrollDetailsTable, filterByFormula: filterDetails });

  const current = findCurrentPeriodRow(detailRecords, new Date());
  if (!current) throw new Error('no_current_pay_period_found');

  const f = current.fields || {};

  const periodStart = toYmd(f['PR Period Start Date']);
  const periodEnd = toYmd(f['PR Period End Date']);
  const validationDate = toYmd(f['PR Period Validation Date']);
  const submitDate = toYmd(f['PR Period Submit Date']);
  const checkDate = toYmd(f['PR Period Check Date']);

  if (!periodStart || !submitDate || !validationDate) throw new Error('pay_period_dates_incomplete');

  const cutoffUtc = computeValidationCutoffUtc({
    validationDateYmd: validationDate,
    endTimeNextDay: validationEndTimeNextDay,
    timeZone,
  });

  const cutoffUtcIso = cutoffUtc ? cutoffUtc.toISOString() : null;
  const cutoffLocal = cutoffUtcIso ? formatLocalCutoff({ cutoffUtcIso, timeZone }) : null;
  const isLate = cutoffUtc ? Date.now() > cutoffUtc.getTime() : false;

  return {
    location_name: name,
    calendar_name: calendarName,

    app_active: appActive,
    time_zone: timeZone,
    validation_end_time_next_day: validationEndTimeNextDay || null,

    payroll_company: payrollCompany || null,
    pos_type: posType || null,
    payroll_project_email: payrollProjectEmail || null,
    tip_report_type: tipReportType || null,
    payroll_company_code: payrollCompanyCode || null,
    pay_frequency: payFrequency || null,

    preview_recipients_count: preview.count,
    preview_recipients_summary: preview.summary,

    asana_connected: asanaConnected,

    current_pay_period: {
      record_id: current.record_id,
      start_date: periodStart,
      end_date: periodEnd,
      validation_date: validationDate,
      submit_date: submitDate,
      check_date: checkDate,
      cutoff_utc: cutoffUtcIso,
      cutoff_local: cutoffLocal,
      is_late: isLate,
      late_message: isLate
        ? 'You have missed the validation window. Please email 911@rdmsgroup.com confirming your payroll is complete. Please note late payroll submission may require additional billing.'
        : null,
    },
  };
}

module.exports = {
  listLocationNames,
  getRecapForLocationName,
};
