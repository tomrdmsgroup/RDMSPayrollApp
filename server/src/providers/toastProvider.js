const DEFAULT_BASE_URL = 'https://api.toasttab.com';

function buildTimeEntriesUrl(baseUrl, clientLocationId, periodStart, periodEnd) {
  const url = new URL('/labor/v1/time-entries', baseUrl || DEFAULT_BASE_URL);
  url.searchParams.set('restaurantGuid', clientLocationId);
  url.searchParams.set('startDate', new Date(periodStart).toISOString());
  url.searchParams.set('endDate', new Date(periodEnd).toISOString());
  return url;
}

async function fetchToastData(clientLocationId, periodStart, periodEnd) {
  const toastToken = process.env.TOAST_API_KEY;
  const toastBaseUrl = process.env.TOAST_BASE_URL || DEFAULT_BASE_URL;
  const locationId = clientLocationId || process.env.TOAST_LOCATION_ID;

  if (!locationId) {
    throw new Error('toast_location_required');
  }
  if (!toastToken) {
    throw new Error('toast_api_key_required');
  }

  const url = buildTimeEntriesUrl(toastBaseUrl, locationId, periodStart, periodEnd);
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${toastToken}`,
    },
  });

  if (!response.ok) {
    const body = await safeParseJson(response);
    const message = body?.error || body?.message || `toast_error_${response.status}`;
    throw new Error(message);
  }

  const data = await response.json();
  const rows = Array.isArray(data?.timeEntries)
    ? data.timeEntries
    : Array.isArray(data)
    ? data
    : [];

  return {
    endpoint: url.toString(),
    count: rows.length,
    rows,
    fetched_at: new Date().toISOString(),
  };
}

async function safeParseJson(response) {
  try {
    return await response.json();
  } catch (e) {
    return null;
  }
}

module.exports = { fetchToastData, buildTimeEntriesUrl };
