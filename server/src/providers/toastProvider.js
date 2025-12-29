// server/src/providers/toastProvider.js
//
// Toast integration (Standard + Analytics) powered by per-location Airtable Vitals.
// This implementation intentionally mirrors the working Google Sheets approach:
//
// - Auth POST includes: { clientId, clientSecret, userAccessType }
// - Labor calls include restaurant GUID in Toast-Restaurant-External-Id
// - Also sets Toast-Access-Type + X-Toast-Access-Type to TOAST_MACHINE_CLIENT
//
// Exports:
//   - getToastConfigFromVitals(vitalsRecord)
//   - fetchToastTimeEntriesFromVitals({ vitalsRecord, periodStart, periodEnd })
//   - fetchToastEraLaborJobsFromVitals({ vitalsRecord, periodStart, periodEnd })
//
// periodStart/periodEnd accepted formats:
//   - "YYYY-MM-DD"
//   - ISO-like "YYYY-MM-DDTHH:mm:ss.SSS±HHMM"

function requireField(obj, key) {
  const v = obj?.[key];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`toast_missing_field:${key}`);
  }
  return String(v).trim();
}

/**
 * Map Airtable's human-friendly TZ to an IANA timezone for Intl usage.
 * Extend as you encounter more.
 */
function normalizeIanaTimeZone(tz) {
  const raw = String(tz || '').trim();
  if (!raw) return 'America/Los_Angeles';

  const map = {
    'Pacific - Los Angeles': 'America/Los_Angeles',
    'Pacific': 'America/Los_Angeles',
    'Eastern - New York': 'America/New_York',
    'Eastern': 'America/New_York',
    'Central': 'America/Chicago',
    'Mountain': 'America/Denver',
  };

  return map[raw] || raw; // if they already store IANA, just use it
}

/**
 * Compute timezone offset minutes for a given IANA zone at a given Date instant.
 * Returns minutes east of UTC (so Los Angeles in winter => -480).
 */
function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});

  // Interpret the formatted time as if it were UTC, then compare.
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return (asUTC - date.getTime()) / 60000;
}

function formatOffsetHHMM(minutes) {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(Math.floor(abs % 60)).padStart(2, '0');
  return `${sign}${hh}${mm}`;
}

function looksLikeToastIso(s) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/.test(String(s || '').trim());
}

function looksLikeYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

/**
 * Convert YYYY-MM-DD into Toast ISO with ±HHMM offset in a specific TZ.
 * We compute offset using noon UTC of that date to stabilize DST handling.
 */
function ymdToToastIso(ymd, timeZone, kind) {
  const [Y, M, D] = ymd.split('-').map(Number);
  const probe = new Date(Date.UTC(Y, M - 1, D, 12, 0, 0));
  const offsetMin = tzOffsetMinutes(probe, timeZone);
  const off = formatOffsetHHMM(offsetMin);

  if (kind === 'start') return `${ymd}T00:00:00.000${off}`;
  return `${ymd}T23:59:59.999${off}`;
}

function resolveToastWindow({ periodStart, periodEnd, timeZone }) {
  const tz = normalizeIanaTimeZone(timeZone);

  const ps = String(periodStart || '').trim();
  const pe = String(periodEnd || '').trim();

  if (looksLikeToastIso(ps) && looksLikeToastIso(pe)) {
    return { startIso: ps, endIso: pe, tz };
  }

  if (looksLikeYmd(ps) && looksLikeYmd(pe)) {
    return {
      startIso: ymdToToastIso(ps, tz, 'start'),
      endIso: ymdToToastIso(pe, tz, 'end'),
      tz,
    };
  }

  throw new Error('toast_invalid_dates');
}

async function httpJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    // leave json null
  }
  return { ok: res.ok, status: res.status, text, json };
}

function getToastConfigFromVitals(vitalsRecord) {
  const fields = vitalsRecord?.fields || vitalsRecord || {};

  return {
    hostname: requireField(fields, 'Toast API Hostname'),
    oauthUrl: requireField(fields, 'Toast API OAuth URL'),
    userAccessType: requireField(fields, 'Toast API User Access Type'),

    restaurantGuid: requireField(fields, 'Toast API Restaurant GUID'),
    restaurantExternalId: String(fields['Toast API Restaurant External ID'] || '').trim() || null,

    // Some endpoints benefit from locationId query param (j101 style)
    toastLocationId: String(fields['Toast Location ID'] || '').trim() || null,

    std: {
      clientId: requireField(fields, 'Toast API Client ID - STANDARD'),
      clientSecret: requireField(fields, 'Toast API Client Secret - STANDARD'),
    },

    analytics: {
      clientId: requireField(fields, 'Toast API Client ID - ANALYTICS'),
      clientSecret: requireField(fields, 'Toast API Client Secret - ANALYTICS'),
      scope: String(fields['Toast Analytics Scope'] || '').trim() || null,
    },

    managementGroupGuid: String(fields['Toast Management Group GUID'] || '').trim() || null,
    timeZone: String(fields['Time Zone'] || '').trim() || 'America/Los_Angeles',
  };
}

async function loginToast({ oauthUrl, clientId, clientSecret, userAccessType }) {
  const payload = { clientId, clientSecret, userAccessType };

  const { ok, status, json, text } = await httpJson(oauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!ok) {
    // Avoid logging secrets; surface status + Toast message.
    throw new Error(`toast_auth_failed:${status}:${text?.slice(0, 220)}`);
  }

  // Toast responses vary a bit across tenants; support common shapes.
  const token =
    json?.token?.accessToken ||
    json?.accessToken ||
    json?.access_token ||
    null;

  if (!token) throw new Error('toast_auth_missing_token');

  return token;
}

function standardHeaders({ token, restaurantGuid, userAccessType }) {
  // Mirror your Sheet’s working approach + add some harmless compat aliases.
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',

    'Toast-Access-Type': userAccessType,
    'X-Toast-Access-Type': userAccessType,

    // ✅ Your tenant: GUID in Toast-Restaurant-External-Id
    'Toast-Restaurant-External-Id': restaurantGuid,

    // Extra aliases (some clusters/proxies look for these)
    'restaurant-external-id': restaurantGuid,
    'Toast-Restaurant-Id': restaurantGuid,
  };
}

async function fetchStandardTimeEntries({ cfg, token, startIso, endIso }) {
  const base = cfg.hostname.replace(/\/+$/, '');
  let pageToken = null;

  const all = [];
  do {
    const u = new URL(`${base}/labor/v1/timeEntries`);
    u.searchParams.set('startDate', startIso);
    u.searchParams.set('endDate', endIso);
    if (cfg.toastLocationId) u.searchParams.set('locationId', cfg.toastLocationId);
    if (pageToken) u.searchParams.set('pageToken', pageToken);

    const { ok, status, json, text } = await httpJson(u.toString(), {
      method: 'GET',
      headers: standardHeaders({
        token,
        restaurantGuid: cfg.restaurantGuid,
        userAccessType: cfg.userAccessType,
      }),
    });

    if (!ok) {
      // 401 here is almost always: missing/incorrect restaurant header OR wrong credential set.
      throw new Error(`toast_time_entries_failed:${status}:${text?.slice(0, 260)}`);
    }

    // Toast sometimes returns array directly or { elements, nextPageToken }
    const arr = Array.isArray(json) ? json : (json?.elements || []);
    for (const te of arr) all.push(te);

    pageToken = json?.nextPageToken || json?.pageToken || json?.cursor || null;
  } while (pageToken);

  return all;
}

function chooseEraRange(startYmd, endYmd) {
  const [y1, m1, d1] = startYmd.split('-').map(Number);
  const [y2, m2, d2] = endYmd.split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  const days = Math.floor((b - a) / 86400000) + 1;
  if (days > 31) throw new Error(`toast_era_range_too_long:${days}`);
  return days <= 7 ? 'week' : 'month';
}

function ymdToBusinessDate(ymd) {
  return Number(ymd.replace(/-/g, '')); // YYYYMMDD
}

async function fetchEraLaborJobs({ cfg, token, periodStartYmd, periodEndYmd }) {
  const base = cfg.hostname.replace(/\/+$/, '');
  const range = chooseEraRange(periodStartYmd, periodEndYmd);

  // Create the report
  const createUrl = `${base}/era/v1/labor/${range}`;
  const body = {
    startBusinessDate: ymdToBusinessDate(periodStartYmd),
    endBusinessDate: ymdToBusinessDate(periodEndYmd),
    restaurantIds: [cfg.restaurantGuid],
    excludedRestaurantIds: [],
    groupBy: ['JOB'],
  };

  const created = await httpJson(createUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!created.ok) {
    throw new Error(`toast_era_create_failed:${created.status}:${created.text?.slice(0, 260)}`);
  }

  const reportId = created.json;
  if (!reportId) throw new Error('toast_era_create_missing_report_id');

  // Poll until ready (your Sheet did ~28 tries)
  const getUrl = `${base}/era/v1/labor/${encodeURIComponent(reportId)}`;
  for (let i = 0; i < 28; i++) {
    const r = await httpJson(getUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (r.ok) {
      const arr = Array.isArray(r.json) ? r.json : [];
      return arr;
    }

    await new Promise((resolve) => setTimeout(resolve, 850));
  }

  throw new Error('toast_era_retrieve_timeout');
}

async function fetchToastTimeEntriesFromVitals({ vitalsRecord, periodStart, periodEnd }) {
  const cfg = getToastConfigFromVitals(vitalsRecord);

  const { startIso, endIso, tz } = resolveToastWindow({
    periodStart,
    periodEnd,
    timeZone: cfg.timeZone,
  });

  const token = await loginToast({
    oauthUrl: cfg.oauthUrl,
    clientId: cfg.std.clientId,
    clientSecret: cfg.std.clientSecret,
    userAccessType: cfg.userAccessType,
  });

  const entries = await fetchStandardTimeEntries({
    cfg,
    token,
    startIso,
    endIso,
  });

  return {
    ok: true,
    mode: 'standard_time_entries',
    window: { startIso, endIso, timeZone: tz },
    identifiers: {
      restaurantGuid: cfg.restaurantGuid,
      toastLocationId: cfg.toastLocationId || null,
    },
    count: entries.length,
    sample: entries.slice(0, 3),
    data: entries,
  };
}

async function fetchToastEraLaborJobsFromVitals({ vitalsRecord, periodStart, periodEnd }) {
  const cfg = getToastConfigFromVitals(vitalsRecord);

  // ERA wants YYYY-MM-DD business dates (not ISO timestamps)
  const ps = String(periodStart || '').trim();
  const pe = String(periodEnd || '').trim();
  if (!looksLikeYmd(ps) || !looksLikeYmd(pe)) throw new Error('toast_era_requires_ymd');

  const token = await loginToast({
    oauthUrl: cfg.oauthUrl,
    clientId: cfg.analytics.clientId,
    clientSecret: cfg.analytics.clientSecret,
    userAccessType: cfg.userAccessType,
  });

  const rows = await fetchEraLaborJobs({
    cfg,
    token,
    periodStartYmd: ps,
    periodEndYmd: pe,
  });

  return {
    ok: true,
    mode: 'analytics_era_jobs',
    window: { startYmd: ps, endYmd: pe },
    identifiers: { restaurantGuid: cfg.restaurantGuid },
    count: rows.length,
    sample: rows.slice(0, 3),
    data: rows,
  };
}

module.exports = {
  getToastConfigFromVitals,
  fetchToastTimeEntriesFromVitals,
  fetchToastEraLaborJobsFromVitals,
};
