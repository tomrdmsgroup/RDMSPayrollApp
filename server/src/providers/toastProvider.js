// server/src/providers/toastProvider.js
//
// Step 3: Read-only Toast proof.
// - Pull Toast config from an Airtable vitals record.
// - OAuth login (clientId/clientSecret/userAccessType) to get a bearer token.
// - Call:
//    (A) STANDARD labor time entries
//    (B) ANALYTICS labor jobs via ERA
// - Never return secrets or tokens.

const { fetchAirtableRecords } = require('./airtableClient');

function normalizeHostname(raw) {
  if (!raw) return null;

  const s = String(raw).trim();
  if (!s) return null;

  // If Airtable contains "https://ws-api.toasttab.com" (or http://...), strip scheme/path.
  if (s.startsWith('http://') || s.startsWith('https://')) {
    try {
      const u = new URL(s);
      return u.host || null;
    } catch (_) {
      // fall through
    }
  }

  // If it contains a path without scheme (rare), try parsing as URL with https base.
  if (s.includes('/') && !s.includes('://')) {
    try {
      const u = new URL(`https://${s}`);
      return u.host || null;
    } catch (_) {
      // fall through
    }
  }

  // Otherwise assume it's already a hostname.
  return s;
}

function safeStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function normalizeMatchString(v) {
  return safeStr(v).toLowerCase();
}

function escapeAirtableString(v) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildLocationCandidates(locationName) {
  const full = safeStr(locationName);
  const root = safeStr(full.split(' - ')[0]);
  if (root && root !== full) return [full, root];
  return [full];
}

function scoreApiConfigMatch(fields, locationName, clientNameField, displayNameField) {
  const locationNorm = normalizeMatchString(locationName);
  const rootNorm = normalizeMatchString(buildLocationCandidates(locationName)[1] || '');
  const displayNorm = normalizeMatchString(fields[displayNameField]);
  const clientNorm = normalizeMatchString(fields[clientNameField]);

  if (displayNorm && displayNorm === locationNorm) return 500;
  if (clientNorm && clientNorm === locationNorm) return 450;
  if (rootNorm && displayNorm && displayNorm === rootNorm) return 400;
  if (rootNorm && clientNorm && clientNorm === rootNorm) return 350;
  if (displayNorm && locationNorm.includes(displayNorm)) return 250;
  if (clientNorm && locationNorm.includes(clientNorm)) return 200;
  return 0;
}

function getAirtableApiConfig() {
  return {
    baseId: safeStr(process.env.AIRTABLE_API_CONFIG_BASE || process.env.AIRTABLE_VITALS_BASE),
    apiKey: safeStr(
      process.env.AIRTABLE_API_CONFIG_API_KEY || process.env.AIRTABLE_VITALS_API_KEY || process.env.AIRTABLE_API_KEY
    ),
    tableName: safeStr(process.env.AIRTABLE_API_CONFIG_TABLE || 'API Config'),
    clientNameField: safeStr(process.env.AIRTABLE_API_CONFIG_CLIENT_NAME_FIELD || 'Client Name'),
    displayNameField: safeStr(process.env.AIRTABLE_API_CONFIG_DISPLAY_NAME_FIELD || 'Display Name'),
  };
}

async function fetchApiConfigFieldsForLocation(locationName) {
  const cfg = getAirtableApiConfig();
  if (!cfg.baseId || !cfg.apiKey || !safeStr(locationName)) return null;

  const candidates = buildLocationCandidates(locationName).filter(Boolean);
  const clauses = [];
  for (const candidate of candidates) {
    const escaped = escapeAirtableString(candidate);
    clauses.push(`{${cfg.clientNameField}}='${escaped}'`);
    clauses.push(`{${cfg.displayNameField}}='${escaped}'`);
  }
  if (!clauses.length) return null;

  const filterByFormula = clauses.length > 1 ? `OR(${clauses.join(',')})` : clauses[0];

  const { records } = await fetchAirtableRecords({
    baseId: cfg.baseId,
    tableName: cfg.tableName,
    apiKey: cfg.apiKey,
    filterByFormula,
  });

  if (!records.length) return null;

  const ranked = records
    .map((record) => ({
      fields: record.fields || {},
      score: scoreApiConfigMatch(record.fields || {}, locationName, cfg.clientNameField, cfg.displayNameField),
    }))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.fields || records[0]?.fields || null;
}

function getToastConfigFromVitals(vitalsRecord, mode = 'standard') {
  const hostname = normalizeHostname(vitalsRecord['Toast API Hostname'] || null);

  const clientId =
    mode === 'analytics'
      ? vitalsRecord['Toast API Client ID - ANALYTICS'] || null
      : vitalsRecord['Toast API Client ID - STANDARD'] || vitalsRecord['Toast API Client ID - ANALYTICS'] || null;

  const clientSecret =
    mode === 'analytics'
      ? vitalsRecord['Toast API Client Secret - ANALYTICS'] || null
      : vitalsRecord['Toast API Client Secret - STANDARD'] || vitalsRecord['Toast API Client Secret - ANALYTICS'] || null;

  const userAccessType = vitalsRecord['Toast API User Access Type'] || null;

  // Header scoping (your tenant worked using GUID in Toast-Restaurant-External-Id)
  const restaurantGuid =
    vitalsRecord['Toast API Restaurant GUID'] ||
    vitalsRecord['Toast API Restaurant External ID'] ||
    null;

  // This should already be a full URL (often includes https://...).
  const oauthUrl = vitalsRecord['Toast API OAuth URL'] || null;

  // Optional passthrough
  const locationId = vitalsRecord['Toast Location ID'] || null;
  const mgmtGroupGuid = vitalsRecord['Toast Management Group GUID'] || null;

  return {
    hostname,
    clientId,
    clientSecret,
    userAccessType,
    restaurantGuid,
    oauthUrl,
    locationId,
    mgmtGroupGuid,
  };
}

function isBarrioLocationName(locationName) {
  return normalizeMatchString(locationName).startsWith('barrio');
}

async function resolveAnalyticsConfigForValidation({ vitalsRecord, locationName }) {
  const fallback = getToastConfigFromVitals(vitalsRecord, 'analytics');
  if (!isBarrioLocationName(locationName)) return fallback;

  const apiFields = await fetchApiConfigFieldsForLocation(locationName);
  if (!apiFields) return fallback;

  const clientId = safeStr(process.env.TOAST_AN_CLIENT_ID_BARRIO) || null;
  const clientSecret = safeStr(process.env.TOAST_AN_CLIENT_SECRET_BARRIO) || null;

  return {
    hostname: normalizeHostname(apiFields['Toast API Hostname'] || null),
    clientId,
    clientSecret,
    userAccessType: apiFields['Toast API User Access Type'] || null,
    restaurantGuid: apiFields['Toast API Restaurant GUID'] || apiFields['Toast API Restaurant External ID'] || null,
    oauthUrl: apiFields['Toast API OAuth URL'] || null,
    locationId: apiFields['Toast Location ID'] || null,
    mgmtGroupGuid: apiFields['Toast Management Group GUID'] || null,
  };
}

async function resolveStandardConfigForTimeEntries({ vitalsRecord, locationName }) {
  const fallback = getToastConfigFromVitals(vitalsRecord, 'standard');
  if (!isBarrioLocationName(locationName)) return fallback;

  const apiFields = await fetchApiConfigFieldsForLocation(locationName);
  if (!apiFields) return fallback;

  const clientId = safeStr(process.env.TOAST_STD_CLIENT_ID_BARRIO) || null;
  const clientSecret = safeStr(process.env.TOAST_STD_CLIENT_SECRET_BARRIO) || null;

  return {
    hostname: normalizeHostname(apiFields['Toast API Hostname'] || null),
    clientId,
    clientSecret,
    userAccessType: apiFields['Toast API User Access Type'] || null,
    restaurantGuid: apiFields['Toast API Restaurant GUID'] || apiFields['Toast API Restaurant External ID'] || null,
    oauthUrl: apiFields['Toast API OAuth URL'] || null,
    locationId: apiFields['Toast Location ID'] || null,
    mgmtGroupGuid: apiFields['Toast Management Group GUID'] || null,
  };
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch (_) {
    return '';
  }
}

function trimDebugValue(value, maxLen = 3000) {
  const s = String(value || '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…[truncated ${s.length - maxLen} chars]`;
}

async function readToastErrorBody(res) {
  const contentType = String(res.headers?.get('content-type') || '').toLowerCase();

  if (contentType.includes('application/json')) {
    const jsonBody = await safeJson(res);
    if (jsonBody !== null) return jsonBody;
  }

  const textBody = await safeText(res);
  if (!textBody) return null;

  return {
    raw: trimDebugValue(textBody),
    contentType: contentType || null,
  };
}

function ymdToBusinessDate(ymd) {
  return Number(String(ymd || '').replaceAll('-', ''));
}

function daysInclusive(ymdStart, ymdEnd) {
  const [ys, ms, ds] = String(ymdStart).split('-').map((x) => Number(x));
  const [ye, me, de] = String(ymdEnd).split('-').map((x) => Number(x));
  const a = Date.UTC(ys, ms - 1, ds);
  const b = Date.UTC(ye, me - 1, de);
  const diffDays = Math.floor((b - a) / 86400000);
  return diffDays + 1;
}

function chooseEraRange(ymdStart, ymdEnd) {
  const d = daysInclusive(ymdStart, ymdEnd);
  if (d > 31) return { ok: false, error: `toast_analytics_period_too_long:${d}_days` };
  return { ok: true, range: d <= 7 ? 'week' : 'month', days: d };
}

async function loginToast({ oauthUrl, clientId, clientSecret, userAccessType }) {
  const res = await fetch(oauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      clientSecret,
      userAccessType,
    }),
  });

  if (!res.ok) {
    const j = await safeJson(res);
    return { ok: false, error: 'toast_auth_failed', status: res.status, details: j || null };
  }

  const j = await safeJson(res);
  const token =
    (j && j.token && j.token.accessToken) ||
    (j && j.accessToken) ||
    (j && j.access_token) ||
    null;

  if (!token) return { ok: false, error: 'toast_auth_missing_token' };

  return { ok: true, token };
}

function standardHeaders({ token, restaurantGuid }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Toast-Access-Type': 'TOAST_MACHINE_CLIENT',
    'X-Toast-Access-Type': 'TOAST_MACHINE_CLIENT',
  };

  if (restaurantGuid) {
    headers['Toast-Restaurant-External-Id'] = restaurantGuid;
    headers['restaurant-external-id'] = restaurantGuid;
    headers['Toast-Restaurant-Id'] = restaurantGuid;
  }

  return headers;
}

function sanitizeToastConfig(cfg) {
  return {
    hostname: cfg.hostname || null,
    oauthUrl: cfg.oauthUrl || null,
    userAccessType: cfg.userAccessType || null,
    restaurantGuid: cfg.restaurantGuid || null,
    locationId: cfg.locationId || null,
    mgmtGroupGuid: cfg.mgmtGroupGuid || null,
    hasClientId: !!cfg.clientId,
    hasClientSecret: !!cfg.clientSecret,
  };
}

async function fetchToastTimeEntriesFromVitals({ vitalsRecord, periodStart, periodEnd, locationName = null }) {
  const cfg = await resolveStandardConfigForTimeEntries({ vitalsRecord, locationName });

  if (!cfg.hostname || !cfg.clientId || !cfg.clientSecret || !cfg.userAccessType || !cfg.restaurantGuid || !cfg.oauthUrl) {
    return {
      ok: false,
      error: 'toast_missing_required_config',
      config: sanitizeToastConfig(cfg),
    };
  }

  const auth = await loginToast({
    oauthUrl: cfg.oauthUrl,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    userAccessType: cfg.userAccessType,
  });

  if (!auth.ok) {
    return { ok: false, error: auth.error, status: auth.status || null, details: auth.details || null };
  }

  const window = {
    startIso: `${periodStart}T00:00:00.000-0800`,
    endIso: `${periodEnd}T23:59:59.999-0800`,
    timeZone: 'America/Los_Angeles',
  };

  const base = `https://${cfg.hostname}`;
  const url = new URL('/labor/v1/timeEntries', base);
  url.searchParams.set('startDate', window.startIso);
  url.searchParams.set('endDate', window.endIso);
  if (cfg.locationId) url.searchParams.set('locationId', cfg.locationId);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: standardHeaders({ token: auth.token, restaurantGuid: cfg.restaurantGuid }),
  });

  if (!res.ok) {
    const j = await safeJson(res);
    return { ok: false, error: 'toast_time_entries_failed', status: res.status, details: j || null };
  }

  const data = await safeJson(res);

  return {
    ok: true,
    mode: 'standard_time_entries',
    window,
    identifiers: {
      restaurantGuid: cfg.restaurantGuid,
      locationId: cfg.locationId || null,
    },
    data,
  };
}

function extractToastRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.employees)) return payload.employees;
  return [];
}

async function fetchToastEmployeesFromVitals({ vitalsRecord, locationName = null }) {
  const cfg = await resolveStandardConfigForTimeEntries({ vitalsRecord, locationName });

  if (!cfg.hostname || !cfg.clientId || !cfg.clientSecret || !cfg.userAccessType || !cfg.restaurantGuid || !cfg.oauthUrl) {
    return {
      ok: false,
      error: 'toast_missing_required_config',
      config: sanitizeToastConfig(cfg),
    };
  }

  const auth = await loginToast({
    oauthUrl: cfg.oauthUrl,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    userAccessType: cfg.userAccessType,
  });

  if (!auth.ok) {
    return { ok: false, error: auth.error, status: auth.status || null, details: auth.details || null };
  }

  const base = `https://${cfg.hostname}`;
  const headers = standardHeaders({ token: auth.token, restaurantGuid: cfg.restaurantGuid });
  const endpoints = ['/labor/v1/employees', '/hr/v1/employees'];

  for (const endpoint of endpoints) {
    const url = new URL(endpoint, base);
    const res = await fetch(url.toString(), { method: 'GET', headers });
    if (!res.ok) continue;

    const data = await safeJson(res);
    return {
      ok: true,
      mode: 'standard_employees',
      endpoint,
      identifiers: {
        restaurantGuid: cfg.restaurantGuid,
        locationId: cfg.locationId || null,
      },
      data: extractToastRows(data),
    };
  }

  return {
    ok: false,
    error: 'toast_employees_failed',
  };
}

async function fetchToastAnalyticsJobsFromVitals({ vitalsRecord, periodStart, periodEnd, locationName = null }) {
  const cfg = await resolveAnalyticsConfigForValidation({ vitalsRecord, locationName });

  if (!cfg.hostname || !cfg.clientId || !cfg.clientSecret || !cfg.userAccessType || !cfg.restaurantGuid || !cfg.oauthUrl) {
    return {
      ok: false,
      error: 'toast_missing_required_config',
      config: sanitizeToastConfig(cfg),
    };
  }

  const rangePick = chooseEraRange(periodStart, periodEnd);
  if (!rangePick.ok) return { ok: false, error: rangePick.error };

  const auth = await loginToast({
    oauthUrl: cfg.oauthUrl,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    userAccessType: cfg.userAccessType,
  });

  if (!auth.ok) {
    return { ok: false, error: auth.error, status: auth.status || null, details: auth.details || null };
  }

  const startBD = ymdToBusinessDate(periodStart);
  const endBD = ymdToBusinessDate(periodEnd);

  const base = `https://${cfg.hostname}`;
  const createUrl = new URL(`/era/v1/labor/${rangePick.range}`, base);

  const createBody = {
    startBusinessDate: startBD,
    endBusinessDate: endBD,
    restaurantIds: [cfg.restaurantGuid],
    excludedRestaurantIds: [],
    groupBy: ['EMPLOYEE', 'JOB'],
  };

  const createRes = await fetch(createUrl.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(createBody),
  });

  if (!createRes.ok) {
    const errorBody = await readToastErrorBody(createRes);
    const requestMeta = {
      url: createUrl.toString(),
      range: rangePick.range,
      body: createBody,
      identifiers: {
        restaurantGuid: cfg.restaurantGuid || null,
        locationId: cfg.locationId || null,
        mgmtGroupGuid: cfg.mgmtGroupGuid || null,
      },
    };

    console.error(
      '[toast_analytics_create_failed]',
      JSON.stringify({
        status: createRes.status,
        statusText: createRes.statusText || null,
        request: requestMeta,
        response: errorBody,
      })
    );

    return {
      ok: false,
      error: 'toast_analytics_create_failed',
      status: createRes.status,
      details: errorBody || null,
      request: requestMeta,
    };
  }

  const createJson = await safeJson(createRes);

  const reportGuid =
    (typeof createJson === 'string' && createJson) ||
    (createJson && createJson.guid) ||
    (createJson && createJson.id) ||
    null;

  if (!reportGuid) {
    return { ok: false, error: 'toast_analytics_create_missing_guid', details: createJson || null };
  }

  const getUrl = new URL(`/era/v1/labor/${encodeURIComponent(reportGuid)}`, base);

  for (let i = 0; i < 28; i++) {
    const r = await fetch(getUrl.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/json' },
    });

    if (r.ok) {
      const rows = await safeJson(r);
      return {
        ok: true,
        mode: 'analytics_jobs',
        window: {
          startBusinessDate: startBD,
          endBusinessDate: endBD,
          days: rangePick.days,
          range: rangePick.range,
        },
        identifiers: {
          restaurantGuid: cfg.restaurantGuid,
        },
        data: Array.isArray(rows) ? rows : rows || null,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 850));
  }

  return { ok: false, error: 'toast_analytics_timeout', details: { reportGuid } };
}

module.exports = {
  fetchToastTimeEntriesFromVitals,
  fetchToastEmployeesFromVitals,
  fetchToastAnalyticsJobsFromVitals,
};
