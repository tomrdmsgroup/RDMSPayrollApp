// server/src/domain/toastOriginalPayPeriodService.js
//
// Fetches original/raw Toast pay period rows for staff audit view.

const { fetchVitalsSnapshot } = require('../providers/vitalsProvider');
const { fetchToastAnalyticsJobsFromVitals } = require('../providers/toastProvider');

function trimErrorText(value, maxLen = 1800) {
  const s = String(value || '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…[truncated ${s.length - maxLen} chars]`;
}

function formatAnalyticsError(analytics) {
  const payload = {
    status: analytics?.status || null,
    request: analytics?.request || null,
    details: analytics?.details || null,
  };
  return trimErrorText(JSON.stringify(payload));
}

function listColumnHeaders(rows) {
  const ordered = [];
  const seen = new Set();

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(key);
      }
    }
  }

  return ordered;
}

async function fetchOriginalToastPayPeriodData({ locationName, periodStart, periodEnd }) {
  const location = String(locationName || '').trim();
  const start = String(periodStart || '').trim();
  const end = String(periodEnd || '').trim();
  if (!location || !start || !end) throw new Error('missing_required_fields');

  const snapshot = await fetchVitalsSnapshot(location);
  const vitalsRecord = (snapshot && snapshot.data && snapshot.data[0]) || null;
  if (!vitalsRecord) throw new Error('toast_vitals_not_found');

  const analytics = await fetchToastAnalyticsJobsFromVitals({
    vitalsRecord,
    periodStart: start,
    periodEnd: end,
    locationName: location,
  });

  if (!analytics.ok) {
    throw new Error(`toast_analytics_failed:${analytics.error || 'unknown'}:${formatAnalyticsError(analytics)}`);
  }

  const payload = analytics.data;
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.rows)
    ? payload.rows
    : Array.isArray(payload?.data)
    ? payload.data
    : [];

  return {
    location_name: location,
    period_start: start,
    period_end: end,
    source: {
      provider: 'toast',
      api_mode: 'analytics_jobs',
      label: 'Toast ERA labor export (raw/original response rows)',
      range: analytics?.window?.range || null,
      days: analytics?.window?.days || null,
    },
    row_count: rows.length,
    columns: listColumnHeaders(rows),
    rows,
  };
}

module.exports = {
  fetchOriginalToastPayPeriodData,
};
