// server/src/providers/toastProvider.js
//
// Step 3: Read-only Toast proof.
// - Pull Toast config from an Airtable vitals record.
// - OAuth login (clientId/clientSecret) to get a bearer token.
// - Call labor time entries for a period.
// - Never return secrets or tokens.

function getToastConfigFromVitals(vitalsRecord) {
  const hostname = vitalsRecord['Toast API Hostname'] || null;

  // For labor/time entries, STANDARD is the right default.
  const clientId =
    vitalsRecord['Toast API Client ID - STANDARD'] ||
    vitalsRecord['Toast API Client ID - ANALYTICS'] ||
    null;

  const clientSecret =
    vitalsRecord['Toast API Client Secret - STANDARD'] ||
    vitalsRecord['Toast API Client Secret - ANALYTICS'] ||
    null;

  // Toast expects Restaurant GUID header (a.k.a. Restaurant External ID header usage in many examples)
  const restaurantGuid =
    vitalsRecord['Toast API Restaurant GUID'] ||
    vitalsRecord['Toast API Restaurant External ID'] ||
    null;

  const oauthUrl = vitalsRecord['Toast API OAuth URL'] || null;

  return { hostname, clientId, clientSecret, restaurantGuid, oauthUrl };
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function toastLogin({ oauthUrl, clientId, clientSecret }) {
  if (!oauthUrl) throw new Error('toast_missing:oauth_url');
  if (!clientId) throw new Error('toast_missing:client_id');
  if (!clientSecret) throw new Error('toast_missing:client_secret');

  const res = await fetch(oauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });

  if (!res.ok) {
    const body = await safeJson(res);
    const msg = body?.message || body?.error || `toast_auth_failed_${res.status}`;
    throw new Error(msg);
  }

  const json = await res.json();
  const token = json?.token || json?.accessToken || json?.access_token || null;
  if (!token) throw new Error('toast_auth_token_missing');

  return { token };
}

function buildToastBase(hostname) {
  if (!hostname) throw new Error('toast_missing:hostname');
  if (hostname.startsWith('http://') || hostname.startsWith('https://')) return hostname;
  return `https://${hostname}`;
}

async function fetchTimeEntries({ hostname, restaurantGuid, token, periodStart, periodEnd }) {
  if (!restaurantGuid) throw new Error('toast_missing:restaurant_guid');
  if (!token) throw new Error('toast_missing:token');
  if (!periodStart || !periodEnd) throw new Error('toast_missing:period');

  const base = buildToastBase(hostname);
  const url = new URL('/labor/v1/timeEntries', base);

  // Toast typically expects ISO timestamps; we’ll send inclusive date boundaries.
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('toast_invalid_dates');
  }

  url.searchParams.set('startDate', start.toISOString());
  url.searchParams.set('endDate', end.toISOString());

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      // Toast restaurant scoping header
      'Toast-Restaurant-External-ID': restaurantGuid,
    },
  });

  if (!res.ok) {
    const body = await safeJson(res);
    const msg = body?.message || body?.error || `toast_time_entries_failed_${res.status}`;
    throw new Error(msg);
  }

  const json = await safeJson(res);
  const rows = Array.isArray(json) ? json : Array.isArray(json?.timeEntries) ? json.timeEntries : [];

  return {
    endpoint: url.toString(),
    count: rows.length,
    sample: rows.slice(0, 3), // tiny sample to prove shape; remove later if desired
  };
}

async function fetchToastTimeEntriesFromVitals({ vitalsRecord, periodStart, periodEnd }) {
  const { hostname, clientId, clientSecret, restaurantGuid, oauthUrl } = getToastConfigFromVitals(vitalsRecord);

  const auth = await toastLogin({ oauthUrl, clientId, clientSecret });

  const result = await fetchTimeEntries({
    hostname,
    restaurantGuid,
    token: auth.token,
    periodStart,
    periodEnd,
  });

  // IMPORTANT: Do not return token/secrets.
  return {
    hostname: hostname || null,
    restaurant_guid_present: !!restaurantGuid,
    period_start: periodStart,
    period_end: periodEnd,
    endpoint: result.endpoint,
    count: result.count,
    sample: result.sample,
    fetched_at: new Date().toISOString(),
  };
}

module.exports = {
  fetchToastTimeEntriesFromVitals,
};
