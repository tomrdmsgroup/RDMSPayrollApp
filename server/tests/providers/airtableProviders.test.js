const assert = require('assert');
const { fetchVitalsSnapshot } = require('../../src/providers/vitalsProvider');
const { fetchPeriods } = require('../../src/providers/payrollCalendarProvider');

async function testFetchVitalsReadsFromAirtable() {
  const originalFetch = global.fetch;
  let capturedUrl;
  let capturedOptions;

  global.fetch = (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          records: [
            {
              id: 'rec1',
              fields: { client_location_id: 'LOC1', toast_employee_id: 'E1', first_name: 'Jane', last_name: 'Doe' },
            },
          ],
        }),
    });
  };

  process.env.AIRTABLE_VITALS_BASE = 'baseV';
  process.env.AIRTABLE_API_KEY = 'key123';
  const snapshot = await fetchVitalsSnapshot('LOC1');

  assert.ok(capturedUrl.toString().includes('/baseV/'));
  assert.ok(new URL(capturedUrl).searchParams.get('filterByFormula').includes('LOC1'));
  assert.equal(capturedOptions.headers.Authorization, 'Bearer key123');
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.data[0].client_location_id, 'LOC1');

  global.fetch = originalFetch;
}

async function testVitalsMissingRequiredFieldFails() {
  const originalFetch = global.fetch;
  global.fetch = () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ records: [{ id: 'rec2', fields: { toast_employee_id: 'E2' } }] }),
    });

  process.env.AIRTABLE_VITALS_BASE = 'baseV';
  process.env.AIRTABLE_VITALS_API_KEY = 'key456';

  let threw = false;
  try {
    await fetchVitalsSnapshot('LOC2');
  } catch (e) {
    threw = true;
    assert.ok(e.message.startsWith('airtable_missing_fields'));
  }

  assert.equal(threw, true, 'vitals should fail when required fields missing');
  global.fetch = originalFetch;
}

async function testFetchPayrollCalendarReadsFromAirtable() {
  const originalFetch = global.fetch;
  let capturedUrl;
  let capturedOptions;

  global.fetch = (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          records: [
            {
              id: 'cal1',
              fields: {
                client_location_id: 'LOC3',
                period_start: '2024-04-01',
                period_end: '2024-04-07',
                validation_date: '2024-04-08',
                cutoff_date: '2024-04-06',
              },
            },
          ],
        }),
    });
  };

  process.env.AIRTABLE_PAYROLL_CALENDAR_BASE = 'baseCal';
  process.env.AIRTABLE_PAYROLL_CALENDAR_API_KEY = 'key789';
  const periods = await fetchPeriods('LOC3');

  assert.ok(capturedUrl.toString().includes('/baseCal/'));
  assert.ok(new URL(capturedUrl).searchParams.get('filterByFormula').includes('LOC3'));
  assert.equal(capturedOptions.headers.Authorization, 'Bearer key789');
  assert.equal(periods.length, 1);
  assert.equal(periods[0].period_end, '2024-04-07');
  assert.equal(periods[0].validation_date, '2024-04-08');

  global.fetch = originalFetch;
}

async function testPayrollCalendarMissingFieldFails() {
  const originalFetch = global.fetch;
  global.fetch = () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ records: [{ id: 'cal2', fields: { period_start: '2024-05-01' } }] }),
    });

  process.env.AIRTABLE_PAYROLL_CALENDAR_BASE = 'baseCal';
  process.env.AIRTABLE_API_KEY = 'key000';

  let threw = false;
  try {
    await fetchPeriods('LOC4');
  } catch (e) {
    threw = true;
    assert.ok(e.message.startsWith('airtable_missing_fields'));
  }

  assert.equal(threw, true, 'calendar should fail when mandatory fields missing');
  global.fetch = originalFetch;
}

module.exports = {
  testFetchVitalsReadsFromAirtable,
  testVitalsMissingRequiredFieldFails,
  testFetchPayrollCalendarReadsFromAirtable,
  testPayrollCalendarMissingFieldFails,
};
