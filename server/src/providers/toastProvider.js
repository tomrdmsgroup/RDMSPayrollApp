// Stub provider - never reinterpret Toast data
function fetchToastData(clientLocationId, periodStart, periodEnd) {
  return { endpoint: 'stub', count: 0, rows: [], fetched_at: new Date().toISOString() };
}
module.exports = { fetchToastData };
