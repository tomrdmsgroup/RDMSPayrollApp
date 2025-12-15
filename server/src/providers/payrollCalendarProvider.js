// Stub provider for payroll calendar details
function fetchPeriods(clientLocationId) {
  return [{ id: 'stub', period_start: '2024-01-01', period_end: '2024-01-07', validation_date: '2024-01-08' }];
}
module.exports = { fetchPeriods };
