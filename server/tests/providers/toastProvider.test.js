const assert = require('assert');
const {
  fetchToastData,
  buildTimeEntriesUrl,
  fetchToastAnalyticsJobsFromVitals,
} = require('../../src/providers/toastProvider');

async function testBuildsExpectedUrl() {
  const url = buildTimeEntriesUrl('https://toast.example', 'LOC1', '2024-01-01', '2024-01-07');
  const params = url.searchParams;
  assert.equal(url.pathname, '/labor/v1/time-entries');
  assert.equal(params.get('restaurantGuid'), 'LOC1');
  assert.ok(params.get('startDate').startsWith('2024-01-01'));
  assert.ok(params.get('endDate').startsWith('2024-01-07'));
}

async function testFetchesToastDataWithAuthAndMapping() {
  const originalFetch = global.fetch;
  let capturedUrl;
  let capturedOptions;
  global.fetch = (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ timeEntries: [{ id: 'abc', hours: 8, otHours: 2, tips: 10 }] }),
    });
  };

  process.env.TOAST_API_KEY = 'test-token';
  const result = await fetchToastData('LOC2', '2024-02-01', '2024-02-08');

  assert.ok(capturedUrl.toString().includes('/labor/v1/time-entries'));
  const params = new URL(capturedUrl).searchParams;
  assert.equal(params.get('restaurantGuid'), 'LOC2');
  assert.equal(capturedOptions.method, 'GET');
  assert.equal(capturedOptions.headers.Authorization, 'Bearer test-token');
  assert.equal(result.count, 1);
  assert.deepEqual(result.rows[0], { id: 'abc', hours: 8, otHours: 2, tips: 10 });

  global.fetch = originalFetch;
}

async function testFetchToastDataHandlesFailures() {
  const originalFetch = global.fetch;
  global.fetch = () =>
    Promise.resolve({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'forbidden' }),
    });

  process.env.TOAST_API_KEY = 'test-token';
  let threw = false;
  try {
    await fetchToastData('LOC3', '2024-03-01', '2024-03-08');
  } catch (e) {
    threw = true;
    assert.equal(e.message, 'forbidden');
  }

  assert.equal(threw, true, 'must throw on Toast error responses');
  global.fetch = originalFetch;
}

async function testToastAnalyticsUsesSingleEmployeeGrouping() {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const entry = { url: url.toString(), method, headers: options.headers || {}, body: options.body || null };
    requests.push(entry);

    if (entry.url.includes('/oauth') && method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({ token: { accessToken: 'analytics-token' } }),
      });
    }

    if (entry.url.includes('/era/v1/labor/') && method === 'POST') {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({ guid: 'report-1' }),
      });
    }

    if (entry.url.includes('/era/v1/labor/report-1') && method === 'GET') {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve([]),
      });
    }

    return Promise.resolve({
      ok: false,
      status: 404,
      statusText: 'not found',
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ error: 'unexpected-url' }),
      text: () => Promise.resolve('unexpected-url'),
    });
  };

  const result = await fetchToastAnalyticsJobsFromVitals({
    vitalsRecord: {
      'Toast API Hostname': 'ws-api.toasttab.com',
      'Toast API Client ID - ANALYTICS': 'cid',
      'Toast API Client Secret - ANALYTICS': 'sec',
      'Toast API User Access Type': 'TOAST_MACHINE_CLIENT',
      'Toast API Restaurant GUID': 'rest-guid-1',
      'Toast API OAuth URL': 'https://auth.toasttab.com/oauth',
    },
    periodStart: '2026-03-01',
    periodEnd: '2026-03-07',
    locationName: 'Barrio',
  });

  assert.equal(result.ok, true);
  const createRequest = requests.find((r) => r.url.includes('/era/v1/labor/week') && r.method === 'POST');
  assert.ok(createRequest, 'expected analytics create request');
  const createBody = JSON.parse(createRequest.body);
  assert.deepEqual(createBody.groupBy, ['EMPLOYEE']);

  global.fetch = originalFetch;
}

module.exports = {
  testBuildsExpectedUrl,
  testFetchesToastDataWithAuthAndMapping,
  testFetchToastDataHandlesFailures,
  testToastAnalyticsUsesSingleEmployeeGrouping,
};
