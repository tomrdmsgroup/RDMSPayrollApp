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
  // This can be a PAT or legacy key. Treat it as a bearer token.
  const token = requireEnv('AIRTABLE_VITALS_API_KEY');
  return { Authorization: `Bearer ${token}` };
}

function escapeAirtableString(v) {
  // Airtable formulas use single quotes for string literals.
  // Escape single quotes by backslash.
  return String(v || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function airtableListAll({ table, filterByFormula }) {
  const urlBase = airtableBaseUrl();
  const headers = {
    ...airtableAuthHeader(),
    'Content-Type': 'application/json',
  };

  let offset = null;
  const out = [];

  for (;;) {
    const params = new URLSearchParams();
    if (filterByFormula) params.set('filterByFormula', filterByFormula);
    if (offset) params.set('offset', offset);

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

  // Accept "11:00 AM", "8:00 AM", "11 AM"
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
  // Airtable date fields usually come through as ISO strings.
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;

  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();

  const mm = String(m).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
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
  // Convert a local date/time in a named time zone into a UTC Date.
  // We do a two-pass correction using Intl to handle DST offsets.

  // First guess: interpret local parts as if they are UTC.
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));

  // Get what that UTC moment looks like in the desired time zone.
  const p1 = localPartsFromUtcDate(guess, timeZone);

  // Compute the delta between desired local parts and the formatted local parts.
  const desired = Date.UTC(y, m - 1, d, hh, mm, ss);
  const got = Date.UTC(p1.year, p1.month - 1, p1.day, p1.hour, p1.minute, p1.second);
  const deltaMs = desired - got;

  // Adjust guess by delta.
  guess = new Date(guess.getTime() + deltaMs);

  // Second pass for safety around DST boundaries.
  const p2 = localPartsFromUtcDate(guess, timeZone);
  const got2 = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second);
  const deltaMs2 = desired - got2;

  return new Date(guess.getTime() + deltaMs2);
}

function computeValidationCutoffUtc({ validationDateYmd, endTimeNextDay, timeZone }) {
  const tz = String(timeZone || '').trim() || 'UTC';

  const nextDayYmd = addDaysYmd(validationDateYmd, 1);
  if (!nextDayYmd) return null;

  const time = parseTime12h(endTimeNextDay) || { hh: 0, mm: 0 }; // default 12:00 AM
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
  // Pick the row where now is between Start and Submit (inclusive), comparing in UTC.
  // Airtable stores dates, so time-of-day is not meaningful here.
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

  // If multiple match, choose the latest start.
  candidates.sort((a, b) => b.start.getTime() - a.start.getTime());
  return candidates[0];
}

async function getRecapForLocationName(locationName) {
  const vitalsTable = requireEnv('AIRTABLE_VITALS_TABLE');
  const locationField = requireEnv('AIRTABLE_VITALS_LOCATION_FIELD');
  const payrollDetailsTable = requireEnv('AIRTABLE_PAYROLL_CALENDAR_DETAILS_TABLE');

  const name = String(locationName || '').trim();
  if (!name) throw new Error('location_name_required');

  // 1) Fetch vitals record
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

  const timeZone = vitals['Time Zone'] || 'UTC';
  const validationEndTimeNextDay = vitals['Validation End Time (Next Day)'] || '';
  const appActive = vitals['PR Validation APP Active?'] === true;

  // 2) Fetch payroll calendar detail rows for that calendar
  const filterDetails = `{PR Calendar Name - Master}='${escapeAirtableString(calendarName)}'`;
  const detailRecords = await airtableListAll({ table: payrollDetailsTable, filterByFormula: filterDetails });

  const current = findCurrentPeriodRow(detailRecords, new Date());
  if (!current) throw new Error('no_current_pay_period_found');

  const f = current.fields;

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

  const isLate = cutoffUtc ? Date.now() > cutoffUtc.getTime() : false;

  return {
    location_name: name,
    calendar_name: calendarName,
    app_active: appActive,
    time_zone: timeZone,
    validation_end_time_next_day: validationEndTimeNextDay || null,

    current_pay_period: {
      record_id: current.record_id,
      start_date: periodStart,
      end_date: periodEnd,
      validation_date: validationDate,
      submit_date: submitDate,
      check_date: checkDate,
      cutoff_utc: cutoffUtc ? cutoffUtc.toISOString() : null,
      is_late: isLate,
      late_message: isLate
        ? 'You have missed the validation window. Please email 911@rdmsgroup.com confirming your payroll is complete. Please note late payroll submission may require additional billing.'
        : null,
    },
  };
}

module.exports = {
  getRecapForLocationName,
};
