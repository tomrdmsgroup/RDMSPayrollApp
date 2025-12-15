// Stub provider for Airtable Vitals reference data
function fetchVitalsSnapshot(clientLocationId) {
  return { fetched_at: new Date().toISOString(), client_location_id: clientLocationId, data: [] };
}
module.exports = { fetchVitalsSnapshot };
