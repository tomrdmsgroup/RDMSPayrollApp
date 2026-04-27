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
    const rawBody = await resp.text();
    let body = {};
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch (_) {
      body = {};
    }

    if (!resp.ok) {
      const bodyPreview = String(rawBody || '').slice(0, 500);
      console.error('[airtable] list failed', {
        table,
        usedFieldsParam: Array.isArray(fields) && fields.length > 0,
        filterByFormula: filterByFormula || null,
        requestedFields: Array.isArray(fields) ? fields : [],
        status: resp.status,
        bodyPreview,
      });
      throw new Error(`airtable_list_failed:${resp.status}`);
    }

    (body.records || []).forEach((r) => out.push(r));
    offset = body.offset || null;
    if (!offset) break;
  }

  return out;
}

async function airtableListAllFromConfig({ base, token, table, filterByFormula, fields }) {
  const urlBase = `https://api.airtable.com/v0/${base}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

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
    const rawBody = await resp.text();
    let body = {};
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch (_) {
      body = {};
    }

    if (!resp.ok) {
      const bodyPreview = String(rawBody || '').slice(0, 500);
      console.error('[airtable] list failed', {
        base,
        table,
        usedFieldsParam: Array.isArray(fields) && fields.length > 0,
        filterByFormula: filterByFormula || null,
        requestedFields: Array.isArray(fields) ? fields : [],
        status: resp.status,
        bodyPreview,
      });
      throw new Error(`airtable_list_failed:${resp.status}`);
    }

    (body.records || []).forEach((r) => out.push(r));
    offset = body.offset || null;
    if (!offset) break;
  }

  return out;
}

function normalizeNameForMatch(v) {
  return String(v || '').trim().toLowerCase();
}

function getRootLocationName(v) {
  const raw = String(v || '').trim();
  const [root] = raw.split(/\s+-\s+/);
  return String(root || '').trim();
}

function toSafeSlug(v) {
  return String(v || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolveApiConfigAirtableSettings() {
  const base = (process.env.AIRTABLE_API_CONFIG_BASE || process.env.AIRTABLE_VITALS_BASE || '').trim();
  const token = (
    process.env.AIRTABLE_API_CONFIG_API_KEY ||
    process.env.AIRTABLE_VITALS_API_KEY ||
    process.env.AIRTABLE_API_KEY ||
    ''
  ).trim();
  const table = (process.env.AIRTABLE_API_CONFIG_TABLE || 'API Config').trim() || 'API Config';
  const clientNameField = (process.env.AIRTABLE_API_CONFIG_CLIENT_NAME_FIELD || 'Client Name').trim() || 'Client Name';
  const displayNameField = (process.env.AIRTABLE_API_CONFIG_DISPLAY_NAME_FIELD || 'Display Name').trim() || 'Display Name';
  return { base, token, table, clientNameField, displayNameField };
}

function getMatchingApiConfigRecords({ records, locationName, clientNameField, displayNameField }) {
  const selectedName = normalizeNameForMatch(locationName);
  const rootName = normalizeNameForMatch(getRootLocationName(locationName));
  const rows = (records || []).map((record) => {
    const fields = record.fields || {};
    const candidates = [fields[clientNameField], fields[displayNameField]]
      .flat()
      .map((value) => normalizeNameForMatch(value))
      .filter(Boolean);
    return { record, candidates };
  });

  const exact = rows.filter((row) => row.candidates.includes(selectedName)).map((row) => row.record);
  if (exact.length) return { records: exact, matchType: 'exact' };

  if (rootName && rootName !== selectedName) {
    const root = rows.filter((row) => row.candidates.includes(rootName)).map((row) => row.record);
    if (root.length) return { records: root, matchType: 'root' };
  }

  return { records: [], matchType: 'not_found' };
}

function buildToastSecretEnvVarAuditRow({ item, envCandidates }) {
  const expectedEnv = envCandidates[0] || null;
  const configuredEnv =
    envCandidates.find((envName) => {
      const value = process.env[envName];
      return typeof value === 'string' && value.trim() !== '';
    }) || null;
  const resolvedEnv = configuredEnv || expectedEnv;

  return {
    section: 'Toast API',
    item,
    status: configuredEnv ? 'OK' : 'Missing',
    value: resolvedEnv ? `${configuredEnv ? 'Configured' : 'Missing'}: ${resolvedEnv}` : null,
    where_to_fix: resolvedEnv ? `Render → Environment Variables → ${resolvedEnv}` : 'Render → Environment Variables',
  };
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

function findDashboardActivePeriodRow(rows, todayYmd) {
  const today = String(todayYmd || '').trim();
  if (!today) return null;

  const candidates = rows
    .map((r) => {
      const fields = r.fields || {};
      const endDate = toYmd(fields['PR Period End Date']);
      const submitDate = toYmd(fields['PR Period Submit Date']);
      return {
        record_id: r.id,
        fields,
        end_date: endDate,
        submit_date: submitDate,
      };
    })
    .filter((x) => x.end_date && x.submit_date)
    .filter((x) => x.end_date <= today && today <= x.submit_date);

  if (!candidates.length) return null;
  candidates.sort((a, b) => String(b.end_date).localeCompare(String(a.end_date)));
  return candidates[0];
}

function sortRowsByStartAsc(rows) {
  return rows
    .map((r) => ({
      record_id: r.id,
      fields: r.fields || {},
      start: new Date(r.fields['PR Period Start Date']),
      submit: new Date(r.fields['PR Period Submit Date']),
      validation: new Date(r.fields['PR Period Validation Date']),
      end: new Date(r.fields['PR Period End Date']),
      check: new Date(r.fields['PR Period Check Date']),
    }))
    .filter((x) => !Number.isNaN(x.start.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

function toSelectorPeriod(row) {
  if (!row) return null;
  return {
    record_id: row.record_id,
    start_date: toYmd(row.fields['PR Period Start Date']),
    end_date: toYmd(row.fields['PR Period End Date']),
    validation_date: toYmd(row.fields['PR Period Validation Date']),
    submit_date: toYmd(row.fields['PR Period Submit Date']),
    check_date: toYmd(row.fields['PR Period Check Date']),
  };
}

function buildPayPeriodSelectorFromSortedRows(sortedRows, todayYmd) {
  const selectorRows = (sortedRows || [])
    .map((row) => ({ row, period: toSelectorPeriod(row) }))
    .filter((x) => x.period && x.period.start_date && x.period.end_date);

  const currentIndex = selectorRows.findIndex(
    (x) => x.period.start_date <= todayYmd && todayYmd <= x.period.end_date,
  );

  if (currentIndex >= 0) {
    return {
      next_pay_period: selectorRows[currentIndex + 1]?.period || null,
      current_pay_period: selectorRows[currentIndex].period,
      prior_pay_periods: selectorRows
        .slice(0, currentIndex)
        .reverse()
        .map((x) => x.period),
    };
  }

  const nextIndex = selectorRows.findIndex((x) => x.period.start_date > todayYmd);
  if (nextIndex >= 0) {
    return {
      next_pay_period: selectorRows[nextIndex].period,
      current_pay_period: null,
      prior_pay_periods: selectorRows
        .slice(0, nextIndex)
        .reverse()
        .map((x) => x.period),
    };
  }

  return {
    next_pay_period: null,
    current_pay_period: null,
    prior_pay_periods: selectorRows.reverse().map((x) => x.period),
  };
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

function extractUniqueEmailsFromPreviewFields(vitals) {
  const previewFieldNames = [
    'Payroll Preview 1 Email',
    'Payroll Preview 2 Email',
    'Payroll Preview 3 Email',
    'Payroll Preview 4 Email',
    'Payroll Preview 5 Email',
  ];

  const found = [];
  const seen = new Set();
  const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  previewFieldNames.forEach((fieldName) => {
    const raw = vitals[fieldName];
    const values = Array.isArray(raw) ? raw : [raw];

    values.forEach((value) => {
      const text = String(value || '');
      const matches = text.match(emailRegex) || [];
      matches.forEach((matchedEmail) => {
        const trimmed = String(matchedEmail || '').trim();
        if (!trimmed) return;
        const normalized = trimmed.toLowerCase();
        if (seen.has(normalized)) return;
        seen.add(normalized);
        found.push(trimmed);
      });
    });
  });

  return found;
}

async function listLocationNames() {
  const vitalsTable = requireEnv('AIRTABLE_VITALS_TABLE');
  const locationField = requireEnv('AIRTABLE_VITALS_LOCATION_FIELD');

  const recs = await airtableListAll({
    table: vitalsTable,
    fields: [locationField],
  });

  const seen = new Set();
  const names = [];
  recs.forEach((r) => {
    const name = ((r.fields || {})[locationField] || '').toString().trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  });

  names.sort((a, b) => a.localeCompare(b));
  return names;
}

function normalizeCalendarFieldValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = String(item === null || item === undefined ? '' : item).trim();
      if (normalized) return normalized;
    }
    return '';
  }
  return String(value).trim();
}

function resolveCalendarNameFromVitals(vitals) {
  const candidateFields = [
    'PR Calendar',
    'Payroll Calendar (from PR Calendar)',
    'Payroll Calendar',
    'PR Calendar Name',
  ];

  for (const fieldName of candidateFields) {
    const resolved = normalizeCalendarFieldValue(vitals[fieldName]);
    if (resolved) return resolved;
  }

  return null;
}

function normalizeAuditRowValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  if (Array.isArray(value)) {
    const values = value
      .map((entry) => String(entry === null || entry === undefined ? '' : entry).trim())
      .filter(Boolean);
    return values.join(', ');
  }
  return String(value).trim();
}

function toSetupAuditRow({ section, item, value, whereToFix, sensitive = false }) {
  const normalized = normalizeAuditRowValue(value);
  const isMissing = !normalized;
  return {
    section,
    item,
    status: isMissing ? 'Missing' : 'OK',
    value: isMissing ? null : sensitive ? 'Configured' : normalized,
    where_to_fix: whereToFix,
  };
}

async function getAirtableSetupAuditForLocationName(locationName) {
  const vitalsTable = requireEnv('AIRTABLE_VITALS_TABLE');
  const locationField = requireEnv('AIRTABLE_VITALS_LOCATION_FIELD');

  const name = String(locationName || '').trim();
  if (!name) throw new Error('location_name_required');

  const filterVitals = `{${locationField}}='${escapeAirtableString(name)}'`;
  const vitalsRecords = await airtableListAll({ table: vitalsTable, filterByFormula: filterVitals });
  if (!vitalsRecords.length) throw new Error('location_not_found');

  const selectedVitalsRecord = vitalsRecords[0];
  const vitals = selectedVitalsRecord.fields || {};
  const duplicateVitalsRecordIds = vitalsRecords.map((record) => record.id).filter(Boolean);
  const duplicateVitalsRecordCount = duplicateVitalsRecordIds.length;
  if (duplicateVitalsRecordCount > 1) {
    console.warn('[airtableSetupAudit] duplicate vitals records found for location', {
      selected_location: name,
      duplicate_vitals_record_count: duplicateVitalsRecordCount,
      duplicate_vitals_record_ids: duplicateVitalsRecordIds,
    });
  }

  const calendarName = resolveCalendarNameFromVitals(vitals);
  const apiConfigSettings = resolveApiConfigAirtableSettings();
  const toastApiConfigFields = [
    'Toast API Hostname',
    'Toast API Client ID - STANDARD',
    'Toast API Client ID - ANALYTICS',
    'Toast API User Access Type',
    'Toast API OAuth URL',
    'Toast API Restaurant GUID',
    'Toast API Restaurant External ID',
    'Toast Location ID',
    'Toast Management Group GUID',
    'Toast Analytics Scope',
  ];
  const apiConfigRecords =
    apiConfigSettings.base && apiConfigSettings.token
      ? await airtableListAllFromConfig({
          base: apiConfigSettings.base,
          token: apiConfigSettings.token,
          table: apiConfigSettings.table,
          fields: [apiConfigSettings.clientNameField, apiConfigSettings.displayNameField, ...toastApiConfigFields],
        })
      : [];
  const apiConfigMatch = getMatchingApiConfigRecords({
    records: apiConfigRecords,
    locationName: name,
    clientNameField: apiConfigSettings.clientNameField,
    displayNameField: apiConfigSettings.displayNameField,
  });
  const selectedApiConfigRecord = apiConfigMatch.records[0] || null;
  const apiConfigDuplicateRecordIds = apiConfigMatch.records.map((record) => record.id).filter(Boolean);
  const apiConfigDuplicateRecordCount = apiConfigDuplicateRecordIds.length;
  if (apiConfigDuplicateRecordCount > 1) {
    console.warn('[airtableSetupAudit] duplicate API config records found for location', {
      selected_location: name,
      api_config_match_type: apiConfigMatch.matchType,
      api_config_duplicate_record_count: apiConfigDuplicateRecordCount,
      api_config_duplicate_record_ids: apiConfigDuplicateRecordIds,
    });
  }
  const apiConfig = selectedApiConfigRecord ? selectedApiConfigRecord.fields || {} : {};
  const setupAuditFields = {
    'Payroll company': (vitals['Payroll company'] || vitals['Payroll Company'] || '').toString().trim() || null,
    'Payroll company code':
      (vitals['Payroll company code'] || vitals['PR Company Code (for UPload)'] || '').toString().trim() || null,
    'PR Reg Earning Code': (vitals['PR Reg Earning Code'] || '').toString().trim() || null,
    'PR Overtime Earning Code': (vitals['PR Overtime Earning Code'] || '').toString().trim() || null,
    'PR Double Time Earning Code': (vitals['PR Double Time Earning Code'] || '').toString().trim() || null,
    'PR MBP Earning Code': (vitals['PR MBP Earning Code'] || '').toString().trim() || null,
    'PR Tips to Pay Earning Code': (vitals['PR Tips to Pay Earning Code'] || '').toString().trim() || null,
    'PR Tips to Tax Earning Code': (vitals['PR Tips to Tax Earning Code'] || '').toString().trim() || null,
    'PR Sick Hours Earning Code': (vitals['PR Sick Hours Earning Code'] || '').toString().trim() || null,
  };

  const whereVitals = (fieldName) => `Airtable → Client Vitals → ${fieldName}`;
  const whereApiConfig = (fieldName) => `Airtable → API Config → ${fieldName}`;
  const fullSlug = toSafeSlug(name);
  const rootSlug = toSafeSlug(getRootLocationName(name));
  const standardSecretCandidates = [...new Set([rootSlug, fullSlug].filter(Boolean))].map(
    (slug) => `TOAST_STD_CLIENT_SECRET_${slug}`
  );
  const analyticsSecretCandidates = [...new Set([rootSlug, fullSlug].filter(Boolean))].map(
    (slug) => `TOAST_AN_CLIENT_SECRET_${slug}`
  );

  const setupAuditRows = [
    toSetupAuditRow({
      section: 'Payroll Core',
      item: 'PR Calendar / Payroll Calendar',
      value: calendarName,
      whereToFix: whereVitals('PR Calendar'),
    }),
    toSetupAuditRow({
      section: 'Payroll Core',
      item: 'Time Zone',
      value: vitals['Time Zone'],
      whereToFix: whereVitals('Time Zone'),
    }),
    toSetupAuditRow({
      section: 'Payroll Core',
      item: 'Validation End Time (Next Day)',
      value: vitals['Validation End Time (Next Day)'],
      whereToFix: whereVitals('Validation End Time (Next Day)'),
    }),
    toSetupAuditRow({
      section: 'Payroll Core',
      item: 'PR Validation APP Active?',
      value:
        vitals['PR Validation APP Active?'] === true
          ? 'YES'
          : vitals['PR Validation APP Active?'] === false
            ? 'NO'
            : null,
      whereToFix: whereVitals('PR Validation APP Active?'),
    }),
    toSetupAuditRow({
      section: 'Payroll Core',
      item: 'Payroll Company',
      value: setupAuditFields['Payroll company'],
      whereToFix: whereVitals('Payroll company'),
    }),
    toSetupAuditRow({
      section: 'Payroll Core',
      item: 'Payroll company code',
      value: setupAuditFields['Payroll company code'],
      whereToFix: whereVitals('Payroll company code'),
    }),
    toSetupAuditRow({
      section: 'Payroll Core',
      item: 'PR Pay Frequency for Upload',
      value: vitals['PR Pay Frequency for Upload'],
      whereToFix: whereVitals('PR Pay Frequency for Upload'),
    }),
    toSetupAuditRow({
      section: 'Payroll Core',
      item: 'PR RDMS Payroll Project Email Address',
      value: vitals['PR RDMS Payroll Project Email Address'],
      whereToFix: whereVitals('PR RDMS Payroll Project Email Address'),
    }),
    toSetupAuditRow({
      section: 'Payroll Core',
      item: 'PR Tip Report Type',
      value: vitals['PR Tip Report Type'],
      whereToFix: whereVitals('PR Tip Report Type'),
    }),
    toSetupAuditRow({
      section: 'Contacts',
      item: 'Payroll Preview 1 Email',
      value: vitals['Payroll Preview 1 Email'],
      whereToFix: whereVitals('Payroll Preview 1 Email'),
    }),
    toSetupAuditRow({
      section: 'Contacts',
      item: 'Payroll Preview 2 Email',
      value: vitals['Payroll Preview 2 Email'],
      whereToFix: whereVitals('Payroll Preview 2 Email'),
    }),
    toSetupAuditRow({
      section: 'Contacts',
      item: 'Payroll Preview 3 Email',
      value: vitals['Payroll Preview 3 Email'],
      whereToFix: whereVitals('Payroll Preview 3 Email'),
    }),
    toSetupAuditRow({
      section: 'Contacts',
      item: 'Payroll Preview 4 Email',
      value: vitals['Payroll Preview 4 Email'],
      whereToFix: whereVitals('Payroll Preview 4 Email'),
    }),
    toSetupAuditRow({
      section: 'Contacts',
      item: 'Payroll Preview 5 Email',
      value: vitals['Payroll Preview 5 Email'],
      whereToFix: whereVitals('Payroll Preview 5 Email'),
    }),
    toSetupAuditRow({
      section: 'Asana',
      item: 'PR Asana Project GUID',
      value: vitals['PR Asana Project GUID'],
      whereToFix: whereVitals('PR Asana Project GUID'),
    }),
    toSetupAuditRow({
      section: 'Asana',
      item: 'PR Asana Inbox Section GUID',
      value: vitals['PR Asana Inbox Section GUID'],
      whereToFix: whereVitals('PR Asana Inbox Section GUID'),
    }),
    toSetupAuditRow({
      section: 'ADP / Earnings',
      item: 'PR Reg Earning Code',
      value: setupAuditFields['PR Reg Earning Code'],
      whereToFix: whereVitals('PR Reg Earning Code'),
    }),
    toSetupAuditRow({
      section: 'ADP / Earnings',
      item: 'PR Overtime Earning Code',
      value: setupAuditFields['PR Overtime Earning Code'],
      whereToFix: whereVitals('PR Overtime Earning Code'),
    }),
    toSetupAuditRow({
      section: 'ADP / Earnings',
      item: 'PR Double Time Earning Code',
      value: setupAuditFields['PR Double Time Earning Code'],
      whereToFix: whereVitals('PR Double Time Earning Code'),
    }),
    toSetupAuditRow({
      section: 'ADP / Earnings',
      item: 'PR MBP Earning Code',
      value: setupAuditFields['PR MBP Earning Code'],
      whereToFix: whereVitals('PR MBP Earning Code'),
    }),
    toSetupAuditRow({
      section: 'ADP / Earnings',
      item: 'PR Tips to Pay Earning Code',
      value: setupAuditFields['PR Tips to Pay Earning Code'],
      whereToFix: whereVitals('PR Tips to Pay Earning Code'),
    }),
    toSetupAuditRow({
      section: 'ADP / Earnings',
      item: 'PR Tips to Tax Earning Code',
      value: setupAuditFields['PR Tips to Tax Earning Code'],
      whereToFix: whereVitals('PR Tips to Tax Earning Code'),
    }),
    toSetupAuditRow({
      section: 'ADP / Earnings',
      item: 'PR Sick Hours Earning Code',
      value: setupAuditFields['PR Sick Hours Earning Code'],
      whereToFix: whereVitals('PR Sick Hours Earning Code'),
    }),
    toSetupAuditRow({
      section: 'Toast API',
      item: 'Toast API Hostname',
      value: apiConfig['Toast API Hostname'],
      whereToFix: whereApiConfig('Toast API Hostname'),
    }),
    toSetupAuditRow({
      section: 'Toast API',
      item: 'Toast API Client ID - STANDARD',
      value: apiConfig['Toast API Client ID - STANDARD'],
      whereToFix: whereApiConfig('Toast API Client ID - STANDARD'),
    }),
    toSetupAuditRow({
      section: 'Toast API',
      item: 'Toast API Client ID - ANALYTICS',
      value: apiConfig['Toast API Client ID - ANALYTICS'],
      whereToFix: whereApiConfig('Toast API Client ID - ANALYTICS'),
    }),
    buildToastSecretEnvVarAuditRow({
      item: 'Toast Standard Client Secret Env Var',
      envCandidates: standardSecretCandidates,
    }),
    buildToastSecretEnvVarAuditRow({
      item: 'Toast Analytics Client Secret Env Var',
      envCandidates: analyticsSecretCandidates,
    }),
    toSetupAuditRow({
      section: 'Toast API',
      item: 'Toast API User Access Type',
      value: apiConfig['Toast API User Access Type'],
      whereToFix: whereApiConfig('Toast API User Access Type'),
    }),
    toSetupAuditRow({
      section: 'Toast API',
      item: 'Toast API OAuth URL',
      value: apiConfig['Toast API OAuth URL'],
      whereToFix: whereApiConfig('Toast API OAuth URL'),
    }),
    toSetupAuditRow({
      section: 'Toast API',
      item: 'Toast API Restaurant GUID',
      value: apiConfig['Toast API Restaurant GUID'],
      whereToFix: whereApiConfig('Toast API Restaurant GUID'),
    }),
    toSetupAuditRow({
      section: 'Toast API',
      item: 'Toast API Restaurant External ID',
      value: apiConfig['Toast API Restaurant External ID'],
      whereToFix: whereApiConfig('Toast API Restaurant External ID'),
    }),
    toSetupAuditRow({
      section: 'Toast API',
      item: 'Toast Location ID',
      value: apiConfig['Toast Location ID'],
      whereToFix: whereApiConfig('Toast Location ID'),
    }),
    toSetupAuditRow({
      section: 'Toast API',
      item: 'Toast Management Group GUID',
      value: apiConfig['Toast Management Group GUID'],
      whereToFix: whereApiConfig('Toast Management Group GUID'),
    }),
    toSetupAuditRow({
      section: 'Toast API',
      item: 'Toast Analytics Scope',
      value: apiConfig['Toast Analytics Scope'],
      whereToFix: whereApiConfig('Toast Analytics Scope'),
    }),
  ];

  return {
    location_name: name,
    calendar_name: calendarName || null,
    vitals_record_id: selectedVitalsRecord.id || null,
    duplicate_vitals_record_count: duplicateVitalsRecordCount,
    duplicate_vitals_record_ids: duplicateVitalsRecordIds,
    api_config_record_id: selectedApiConfigRecord ? selectedApiConfigRecord.id || null : null,
    api_config_match_type: apiConfigMatch.matchType,
    api_config_duplicate_record_count: apiConfigDuplicateRecordCount,
    api_config_duplicate_record_ids: apiConfigDuplicateRecordIds,
    setup_audit_fields: setupAuditFields,
    setup_audit_rows: setupAuditRows,
  };
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

  const calendarName = resolveCalendarNameFromVitals(vitals);

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

  const setupAuditFields = {
    'Payroll company': (vitals['Payroll company'] || payrollCompany || '').toString().trim() || null,
    'Payroll company code': (vitals['Payroll company code'] || payrollCompanyCode || '').toString().trim() || null,
    'PR Reg Earning Code': (vitals['PR Reg Earning Code'] || '').toString().trim() || null,
    'PR Overtime Earning Code': (vitals['PR Overtime Earning Code'] || '').toString().trim() || null,
    'PR Double Time Earning Code': (vitals['PR Double Time Earning Code'] || '').toString().trim() || null,
    'PR MBP Earning Code': (vitals['PR MBP Earning Code'] || '').toString().trim() || null,
    'PR Tips to Pay Earning Code': (vitals['PR Tips to Pay Earning Code'] || '').toString().trim() || null,
    'PR Tips to Tax Earning Code': (vitals['PR Tips to Tax Earning Code'] || '').toString().trim() || null,
    'PR Sick Hours Earning Code': (vitals['PR Sick Hours Earning Code'] || '').toString().trim() || null,
  };

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
    setup_audit_fields: setupAuditFields,

    preview_recipients_count: preview.count,
    preview_recipients_summary: preview.summary,

    asana_project_guid: asanaProjectGuid || null,
    asana_inbox_section_guid: asanaInboxGuid || null,
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

async function getPayPeriodSelectorForLocationName(locationName) {
  const vitalsTable = requireEnv('AIRTABLE_VITALS_TABLE');
  const locationField = requireEnv('AIRTABLE_VITALS_LOCATION_FIELD');
  const payrollDetailsTable = requireEnv('AIRTABLE_PAYROLL_CALENDAR_DETAILS_TABLE');

  const name = String(locationName || '').trim();
  if (!name) throw new Error('location_name_required');

  const filterVitals = `{${locationField}}='${escapeAirtableString(name)}'`;
  const vitalsRecords = await airtableListAll({ table: vitalsTable, filterByFormula: filterVitals });
  if (!vitalsRecords.length) throw new Error('location_not_found');

  const vitals = vitalsRecords[0].fields || {};
  const calendarName = resolveCalendarNameFromVitals(vitals);
  if (!calendarName) throw new Error('missing_payroll_calendar_name');

  const filterDetails = `{PR Calendar Name - Master}='${escapeAirtableString(calendarName)}'`;
  const detailRecords = await airtableListAll({ table: payrollDetailsTable, filterByFormula: filterDetails });
  const rows = sortRowsByStartAsc(detailRecords);
  if (!rows.length) throw new Error('no_pay_periods_found');

  const todayYmd = toYmd(new Date());
  const selector = buildPayPeriodSelectorFromSortedRows(rows, todayYmd);

  return {
    location_name: name,
    payroll_calendar: calendarName,
    current_pay_period: selector.current_pay_period,
    next_pay_period: selector.next_pay_period,
    prior_pay_periods: selector.prior_pay_periods,
    debug: {
      detail_row_count: rows.length,
      todayYmd: todayYmd || null,
      current_found: Boolean(selector.current_pay_period),
      next_found: Boolean(selector.next_pay_period),
      prior_count: selector.prior_pay_periods.length,
    },
  };
}

function normalizeScalarOrArray(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
      .filter(Boolean);
  }
  const trimmed = String(value).trim();
  return trimmed ? [trimmed] : [];
}

function isReadableLeadValue(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return false;
  return !/^rec[a-zA-Z0-9]{14}$/.test(trimmed);
}

function resolvePrLeadDisplay(vitals) {
  const candidateFields = [
    'PR Lead',
    'PR Lead Name',
    'PR Lead Names',
    'PR Lead (from PR Lead)',
    'PR Lead Lookup',
  ];

  for (const fieldName of candidateFields) {
    const values = normalizeScalarOrArray(vitals[fieldName]).filter(isReadableLeadValue);
    if (values.length) return values.join(', ');
  }

  const fallbackFields = ['PR Lead Email Lookup', 'PR Lead Email'];
  for (const fieldName of fallbackFields) {
    const values = normalizeScalarOrArray(vitals[fieldName]);
    if (values.length) return values.join(', ');
  }

  return '';
}

function getTodayYmdForTimeZone(timeZone) {
  const tz = String(timeZone || '').trim();
  if (!tz) return toYmd(new Date().toISOString());

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());

    const get = (type) => parts.find((p) => p.type === type)?.value;
    const year = get('year');
    const month = get('month');
    const day = get('day');
    if (!year || !month || !day) return toYmd(new Date().toISOString());
    return `${year}-${month}-${day}`;
  } catch (_) {
    return toYmd(new Date().toISOString());
  }
}

function sortDashboardRows(rows) {
  return rows.sort((a, b) => {
    const submitCompare = String(a.submit_date || '').localeCompare(String(b.submit_date || ''));
    if (submitCompare !== 0) return submitCompare;

    const validationCompare = String(a.validation_date || '').localeCompare(String(b.validation_date || ''));
    if (validationCompare !== 0) return validationCompare;

    return String(a.client_name || '').localeCompare(String(b.client_name || ''));
  });
}

function isRdmsProcessesPayrollYes(value) {
  return String(value || '').trim().toUpperCase() === 'YES';
}

async function getActivePayrollDashboardRows() {
  const vitalsTable = requireEnv('AIRTABLE_VITALS_TABLE');
  const locationField = requireEnv('AIRTABLE_VITALS_LOCATION_FIELD');
  const payrollDetailsTable = requireEnv('AIRTABLE_PAYROLL_CALENDAR_DETAILS_TABLE');

  const vitalsRecords = await airtableListAll({ table: vitalsTable });

  const rows = [];
  const todayYmd = getTodayYmdForTimeZone(null);
  const debug = {
    total_vitals_records: vitalsRecords.length,
    eligible_dashboard_clients: 0,
    skipped_missing_client_name: 0,
    skipped_missing_payroll_calendar: 0,
    skipped_not_rdms_processes_payroll_yes: 0,
    calendar_detail_queries: 0,
    calendars_with_zero_detail_rows: 0,
    clients_with_detail_rows_but_no_active_period: 0,
    active_rows_returned: 0,
    skipped_samples: [],
  };
  const addSkippedSample = (sample) => {
    if (debug.skipped_samples.length >= 25) return;
    debug.skipped_samples.push(sample);
  };

  for (const record of vitalsRecords) {
    const fields = record.fields || {};
    const clientName = (fields[locationField] || fields.Name || '').toString().trim();
    const calendarName = resolveCalendarNameFromVitals(fields) || '';
    const rdmsPassed = isRdmsProcessesPayrollYes(fields['RDMS Processes Payroll']);
    const client = {
      client_name: clientName,
      payroll_calendar: calendarName,
      pr_lead: resolvePrLeadDisplay(fields),
    };

    if (!rdmsPassed) {
      debug.skipped_not_rdms_processes_payroll_yes += 1;
      addSkippedSample({
        client_name: client.client_name || null,
        payroll_calendar: client.payroll_calendar || null,
        rdms_processes_payroll: fields['RDMS Processes Payroll'] || null,
        reason: 'rdms_processes_payroll_not_yes',
        todayYmd,
      });
      continue;
    }

    if (!client.client_name) {
      debug.skipped_missing_client_name += 1;
      addSkippedSample({
        client_name: null,
        payroll_calendar: client.payroll_calendar || null,
        rdms_processes_payroll: fields['RDMS Processes Payroll'] || null,
        reason: 'missing_client_name',
        todayYmd,
      });
      continue;
    }

    if (!client.payroll_calendar) {
      debug.skipped_missing_payroll_calendar += 1;
      addSkippedSample({
        client_name: client.client_name,
        payroll_calendar: null,
        rdms_processes_payroll: fields['RDMS Processes Payroll'] || null,
        reason: 'missing_payroll_calendar',
        todayYmd,
      });
      continue;
    }

    debug.eligible_dashboard_clients += 1;
    const filterDetails = `{PR Calendar Name - Master}='${escapeAirtableString(client.payroll_calendar)}'`;
    debug.calendar_detail_queries += 1;
    const detailRecords = await airtableListAll({
      table: payrollDetailsTable,
      filterByFormula: filterDetails,
    });

    if (!detailRecords.length) {
      debug.calendars_with_zero_detail_rows += 1;
      addSkippedSample({
        client_name: client.client_name,
        payroll_calendar: client.payroll_calendar,
        rdms_processes_payroll: fields['RDMS Processes Payroll'] || null,
        reason: 'zero_payroll_calendar_detail_rows',
        detail_row_count: 0,
        todayYmd,
      });
      continue;
    }

    const active = findDashboardActivePeriodRow(detailRecords, todayYmd);
    if (!active) {
      debug.clients_with_detail_rows_but_no_active_period += 1;
      addSkippedSample({
        client_name: client.client_name,
        payroll_calendar: client.payroll_calendar,
        rdms_processes_payroll: fields['RDMS Processes Payroll'] || null,
        reason: 'no_active_period_end_to_submit_window',
        detail_row_count: detailRecords.length,
        todayYmd,
        sample_periods: detailRecords.slice(0, 3).map((detail) => {
          const detailFields = detail.fields || {};
          return {
            start_date: toYmd(detailFields['PR Period Start Date']),
            end_date: toYmd(detailFields['PR Period End Date']),
            submit_date: toYmd(detailFields['PR Period Submit Date']),
          };
        }),
      });
      continue;
    }

    rows.push({
      client_name: client.client_name,
      payroll_calendar: client.payroll_calendar,
      pr_lead: client.pr_lead || '',
      payroll_start_date: toYmd(active.fields['PR Period Start Date']),
      payroll_end_date: toYmd(active.fields['PR Period End Date']),
      validation_date: toYmd(active.fields['PR Period Validation Date']),
      submit_date: toYmd(active.fields['PR Period Submit Date']),
      check_date: toYmd(active.fields['PR Period Check Date']),
      validated_by_client: 'No',
    });
  }
  debug.active_rows_returned = rows.length;

  return {
    refreshed_at: new Date().toISOString(),
    rows: sortDashboardRows(rows),
    debug,
  };
}

async function getCommunicationRecipientsForLocationName(locationName) {
  const vitalsTable = requireEnv('AIRTABLE_VITALS_TABLE');
  const locationField = requireEnv('AIRTABLE_VITALS_LOCATION_FIELD');
  const name = String(locationName || '').trim();
  if (!name) throw new Error('location_name_required');

  const filterVitals = `{${locationField}}='${escapeAirtableString(name)}'`;
  const vitalsRecords = await airtableListAll({ table: vitalsTable, filterByFormula: filterVitals });
  if (!vitalsRecords.length) throw new Error('location_not_found');

  const vitals = vitalsRecords[0].fields || {};
  return {
    location_name: name,
    recipients: extractUniqueEmailsFromPreviewFields(vitals),
  };
}

module.exports = {
  listLocationNames,
  getRecapForLocationName,
  getAirtableSetupAuditForLocationName,
  getPayPeriodSelectorForLocationName,
  buildPayPeriodSelectorFromSortedRows,
  getActivePayrollDashboardRows,
  getCommunicationRecipientsForLocationName,
};
