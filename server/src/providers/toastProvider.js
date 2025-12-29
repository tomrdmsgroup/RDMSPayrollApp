// server/src/providers/toastProvider.js
//
// Step 3: Read-only Toast proof.
// - Pull Toast config from an Airtable vitals record.
// - OAuth login (clientId/clientSecret/userAccessType) to get a bearer token.
// - Call:
//    (A) STANDARD labor time entries (already working)
//    (B) ANALYTICS labor jobs via ERA (new)
// - Never return secrets or tokens.

function getToastConfigFromVitals(vitalsRecord, mode = 'standard') {
  const hostname = vitalsRecord['Toast API Hostname'] || null;

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

  const oauthUrl = vitalsRecord['Toast API OAuth URL'] || null;

  // Optional but useful to pass through (not required by these endpoints)
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

async function safeJson(res) {
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

function ymdToBusinessDate(ymd) {
  // ymd expected: YYYY-MM-DD
  return Number(String(ymd || '').replaceAll('-', ''));
}

function daysInclusive(ymdStart, ymdEnd) {
  // Interpret as UTC-midnight dates to avoid tz surprises (inputs are already date-only)
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
      userAccessType, // REQUIRED (your earlier error proves this)
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
  // Matching what worked in your Google Sheet: GUID passed in Toast-Restaurant-External-Id
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Toast-Access-Type': 'TOAST_MACHINE_CLIENT',
    'X-Toast-Access-Type': 'TOAST_MACHINE_CLIENT',
  };

  if (restaurantGuid) {
    headers['Toast-Restaurant-External-Id'] = restaurantGuid;
    // harmless extras
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

async function fetchToastTimeEntriesFromVitals({ vitalsRecord, periodStart, periodEnd }) {
  const cfg = getToastConfigFromVitals(vitalsRecord, 'standard');

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

  // Inputs are date-only; server already validates + converts to ISO window for labor/v1
  const window = {
    startIso: `${periodStart}T00:00:00.000-0800`,
    endIso: `${periodEnd}T23:59:59.999-0800`,
    timeZone: 'America/Los_Angeles',
  };

  const url = `https://${cfg.hostname}/labor/v1/timeEntries?startDate=${encodeURIComponent(
    window.startIso
  )}&endDate=${encodeURIComponent(window.endIso)}${cfg.locationId ? `&locationId=${encodeURIComponent(cfg.locationId)}` : ''}`;

  const res = await fetch(url, {
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

async function fetchToastAnalyticsJobsFromVitals({ vitalsRecord, periodStart, periodEnd }) {
  const cfg = getToastConfigFromVitals(vitalsRecord, 'analytics');

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

  const createUrl = `https://${cfg.hostname}/era/v1/labor/${rangePick.range}`;

  const createBody = {
    startBusinessDate: startBD,
    endBusinessDate: endBD,
    restaurantIds: [cfg.restaurantGuid], // GUIDs go in BODY for ERA
    excludedRestaurantIds: [],
    groupBy: ['JOB'],
  };

  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(createBody),
  });

  if (!createRes.ok) {
    const j = await safeJson(createRes);
    return { ok: false, error: 'toast_analytics_create_failed', status: createRes.status, details: j || null };
  }

  const createJson = await safeJson(createRes);

  // Toast returns a guid string (sometimes JSON string, sometimes object). Normalize.
  const reportGuid =
    (typeof createJson === 'string' && createJson) ||
    (createJson && createJson.guid) ||
    (createJson && createJson.id) ||
    null;

  if (!reportGuid) {
    return { ok: false, error: 'toast_analytics_create_missing_guid', details: createJson || null };
  }

  const getUrl = `https://${cfg.hostname}/era/v1/labor/${encodeURIComponent(reportGuid)}`;

  // Poll until ready (Toast often returns non-200 until finished)
  for (let i = 0; i < 28; i++) {
    const r = await fetch(getUrl, {
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

    // Backoff-ish wait
    await new Promise((resolve) => setTimeout(resolve, 850));
  }

  return { ok: false, error: 'toast_analytics_timeout', details: { reportGuid } };
}

module.exports = {
  fetchToastTimeEntriesFromVitals,
  fetchToastAnalyticsJobsFromVitals,
};
