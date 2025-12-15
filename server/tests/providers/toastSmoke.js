/*
 * Manual smoke test: requires env TOAST_API_KEY, TOAST_LOCATION_ID (or pass a location id as arg),
 * optional TOAST_BASE_URL to point at a sandbox host.
 * Usage example:
 *   TOAST_API_KEY=token TOAST_LOCATION_ID=location-id node tests/providers/toastSmoke.js 2024-05-01 2024-05-07
 */
const { fetchToastData } = require('../../src/providers/toastProvider');

async function main() {
  const [, , startArg, endArg, locationArg] = process.argv;
  const periodStart = startArg || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const periodEnd = endArg || new Date().toISOString();
  const locationId = locationArg || process.env.TOAST_LOCATION_ID;

  try {
    const result = await fetchToastData(locationId, periodStart, periodEnd);
    console.log('Toast fetch succeeded');
    console.log(JSON.stringify({ endpoint: result.endpoint, count: result.count }, null, 2));
  } catch (e) {
    console.error('Toast fetch failed:', e.message);
    process.exitCode = 1;
  }
}

main();
