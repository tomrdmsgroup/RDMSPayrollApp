// server/src/domain/toastOriginalPayPeriodService.js
//
// Fetches Toast pay period rows for staff audit view, shaped to resemble
// Toast Payroll Export CSV output as closely as possible from available APIs.

const { fetchVitalsSnapshot } = require('../providers/vitalsProvider');
const { fetchToastTimeEntriesFromVitals } = require('../providers/toastProvider');

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

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIsoDate(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }
  if (typeof value === 'number') {
    const s = String(Math.trunc(value));
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return null;
}

function pick(obj, paths) {
  for (const p of paths) {
    const parts = p.split('.');
    let cur = obj;
    let ok = true;
    for (const key of parts) {
      if (!cur || typeof cur !== 'object' || !(key in cur)) {
        ok = false;
        break;
      }
      cur = cur[key];
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return null;
}

function extractTimeEntryRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.timeEntries)) return payload.timeEntries;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

function normalizeTimeEntry(entry, { location, periodStart, periodEnd }) {
  const employeeId = pick(entry, ['employee.id', 'employee.guid', 'employeeId', 'employeeGuid', 'employee.id']);
  const employeeName = pick(entry, [
    'employee.fullName',
    'employee.name',
    'employeeName',
    'employeeFullName',
    'name',
  ]);
  const jobCode = pick(entry, ['job.id', 'job.guid', 'jobCode', 'job.id']);
  const jobName = pick(entry, ['job.name', 'jobName', 'jobTitle', 'departmentName']);

  const businessDate =
    toIsoDate(pick(entry, ['businessDate'])) ||
    toIsoDate(pick(entry, ['shiftDate', 'inDate', 'clockInDate', 'clockIn']));

  const regularHours = toNum(pick(entry, ['regularHours', 'hoursRegular', 'hours']));
  const overtimeHours = toNum(pick(entry, ['overtimeHours', 'otHours']));
  const totalHours = toNum(pick(entry, ['totalHours'])) ?? ((regularHours || 0) + (overtimeHours || 0) || null);
  const hourlyRate = toNum(pick(entry, ['hourlyRate', 'regularRate', 'wageRate']));
  const wageAmount = toNum(pick(entry, ['wage', 'wageCost', 'regularCost', 'laborCost']));

  const cashTips = toNum(pick(entry, ['cashTips', 'tips.cash', 'tips']));
  const declaredTips = toNum(pick(entry, ['declaredTips', 'tips.declared']));
  const nonCashTips = toNum(pick(entry, ['nonCashTips', 'tips.nonCash']));

  return {
    location_name: location,
    pay_period_start: periodStart,
    pay_period_end: periodEnd,
    business_date: businessDate,
    employee_id: employeeId ? String(employeeId) : null,
    employee_name: employeeName ? String(employeeName).trim() : null,
    job_code: jobCode ? String(jobCode) : null,
    job_name: jobName ? String(jobName).trim() : null,
    regular_hours: regularHours,
    overtime_hours: overtimeHours,
    total_hours: totalHours,
    hourly_rate: hourlyRate,
    wage_amount: wageAmount,
    cash_tips: cashTips,
    declared_tips: declaredTips,
    non_cash_tips: nonCashTips,
    source_time_entry_id: pick(entry, ['id', 'guid', 'timeEntryId']) || null,
  };
}

async function fetchOriginalToastPayPeriodData({ locationName, periodStart, periodEnd }) {
  const location = String(locationName || '').trim();
  const start = String(periodStart || '').trim();
  const end = String(periodEnd || '').trim();
  if (!location || !start || !end) throw new Error('missing_required_fields');

  const snapshot = await fetchVitalsSnapshot(location);
  const vitalsRecord = (snapshot && snapshot.data && snapshot.data[0]) || null;
  if (!vitalsRecord) throw new Error('toast_vitals_not_found');

  const standard = await fetchToastTimeEntriesFromVitals({
    vitalsRecord,
    periodStart: start,
    periodEnd: end,
    locationName: location,
  });

  if (!standard.ok) {
    throw new Error(`toast_time_entries_failed:${standard.error || 'unknown'}:${formatAnalyticsError(standard)}`);
  }

  const rawRows = extractTimeEntryRows(standard.data);
  const rows = rawRows.map((row) => normalizeTimeEntry(row, { location, periodStart: start, periodEnd: end }));

  return {
    location_name: location,
    period_start: start,
    period_end: end,
    source: {
      provider: 'toast',
      api_mode: 'standard_time_entries_reconstructed_for_payroll_export',
      label: 'Toast Labor /timeEntries transformed to payroll-export-like rows',
      row_grain: 'time-entry-level rows normalized to payroll-export-like columns',
      exact_payroll_export_endpoint_available: false,
      note:
        'Direct Toast Payroll Export endpoint is not configured in this codebase; data is reconstructed from labor/v1/timeEntries.',
    },
    row_count: rows.length,
    columns: listColumnHeaders(rows),
    rows,
  };
}

module.exports = {
  fetchOriginalToastPayPeriodData,
};
