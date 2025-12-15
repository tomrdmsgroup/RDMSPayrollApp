const assert = require('assert');
const { fetchToastData, buildTimeEntriesUrl } = require('../../src/providers/toastProvider');

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

module.exports = { testBuildsExpectedUrl, testFetchesToastDataWithAuthAndMapping, testFetchToastDataHandlesFailures };
