// server/src/providers/toastProvider.js
//
// Step 3: Read-only Toast proof.
// - Pull Toast config from an Airtable vitals record.
// - OAuth login (clientId/clientSecret/userAccessType) to get a bearer token.
// - Call:
//    (A) STANDARD labor time entries
//    (B) ANALYTICS labor jobs via ERA
// - Never return secrets or tokens.

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

async function safeJson(res) {
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
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

  const base = `https://${cfg.hostname}`;
  const createUrl = new URL(`/era/v1/labor/${rangePick.range}`, base);

  const createBody = {
    startBusinessDate: startBD,
    endBusinessDate: endBD,
    restaurantIds: [cfg.restaurantGuid],
    excludedRestaurantIds: [],
    groupBy: ['JOB'],
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
    const j = await safeJson(createRes);
    return { ok: false, error: 'toast_analytics_create_failed', status: createRes.status, details: j || null };
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
  fetchToastAnalyticsJobsFromVitals,
};
