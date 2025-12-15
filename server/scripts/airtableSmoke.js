const { fetchVitalsSnapshot } = require('../src/providers/vitalsProvider');
const { fetchPeriods } = require('../src/providers/payrollCalendarProvider');

async function run() {
  const locationId = process.argv[2] || process.env.SMOKE_LOCATION_ID;
  if (!locationId) {
    console.error('Usage: node scripts/airtableSmoke.js <client_location_id>');
    process.exit(1);
  }

  try {
    console.log('Fetching Vitals...');
    const vitals = await fetchVitalsSnapshot(locationId);
    console.log(JSON.stringify(vitals, null, 2));

    console.log('Fetching Payroll Calendar...');
    const periods = await fetchPeriods(locationId);
    console.log(JSON.stringify(periods, null, 2));
  } catch (err) {
    console.error('Smoke test failed:', err.message);
    process.exit(1);
  }
}

run();
