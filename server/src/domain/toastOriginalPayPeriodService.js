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
  const locationCode = pick(entry, ['location.id', 'location.guid', 'locationCode', 'restaurantGuid']);
  const locationName = pick(entry, ['location.name', 'locationName']) || location;

  const businessDate =
    toIsoDate(pick(entry, ['businessDate'])) ||
    toIsoDate(pick(entry, ['shiftDate', 'inDate', 'clockInDate', 'clockIn']));

  const regularHours = toNum(pick(entry, ['regularHours', 'hoursRegular', 'hours']));
  const overtimeHours = toNum(pick(entry, ['overtimeHours', 'otHours']));
  const totalHours = toNum(pick(entry, ['totalHours'])) ?? ((regularHours || 0) + (overtimeHours || 0) || null);
  const hourlyRate = toNum(pick(entry, ['hourlyRate', 'regularRate', 'wageRate']));
  const wageAmount = toNum(pick(entry, ['wage', 'wageCost', 'regularCost', 'laborCost']));
  const regularPay = toNum(pick(entry, ['regularPay', 'pay.regular', 'regularWage']));
  const overtimePay = toNum(pick(entry, ['overtimePay', 'pay.overtime', 'otPay']));
  const totalPay = toNum(pick(entry, ['totalPay', 'pay.total', 'grossPay'])) || wageAmount;

  const cashTips = toNum(pick(entry, ['cashTips', 'tips.cash', 'tips']));
  const declaredTips = toNum(pick(entry, ['declaredTips', 'tips.declared']));
  const nonCashTips = toNum(pick(entry, ['nonCashTips', 'tips.nonCash']));
  const tipsWithheld = toNum(pick(entry, ['tipsWithheld', 'withheldTips']));
  const totalGratuity = toNum(pick(entry, ['totalGratuity', 'gratuity', 'autoGratuity']));
  const netSales = toNum(pick(entry, ['netSales', 'sales.net']));

  return {
    location_name: location,
    location_code: locationCode ? String(locationCode) : null,
    location_display_name: locationName ? String(locationName).trim() : location,
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
    regular_pay: regularPay,
    overtime_pay: overtimePay,
    total_pay: totalPay,
    net_sales: netSales,
    cash_tips: cashTips,
    declared_tips: declaredTips,
    non_cash_tips: nonCashTips,
    tips_withheld: tipsWithheld,
    total_gratuity: totalGratuity,
    source_time_entry_id: pick(entry, ['id', 'guid', 'timeEntryId']) || null,
  };
}

function sumNullable(current, next) {
  if (next === null || next === undefined) return current;
  return (current || 0) + next;
}

function buildPayrollExportRows(detailRows, fallbackLocationCode = null) {
  const byEmployeeJob = new Map();
  for (const row of detailRows) {
    const employeeId = row.employee_id || '';
    const employeeName = row.employee_name || '';
    const jobCode = row.job_code || '';
    const jobTitle = row.job_name || '';
    const locationName = row.location_display_name || row.location_name || '';
    const locationCode = row.location_code || fallbackLocationCode || '';
    const key = [employeeId, employeeName, jobCode, jobTitle, locationName, locationCode].join('|||');
    if (!byEmployeeJob.has(key)) {
      byEmployeeJob.set(key, {
        Employee: row.employee_name || null,
        'Job Title': row.job_name || null,
        'Regular Hours': 0,
        'Overtime Hours': 0,
        HourlyRateWeightedSum: 0,
        HourlyRateWeight: 0,
        HourlyRateSamples: 0,
        'Regular Pay': 0,
        'Overtime Pay': 0,
        TotalPayFromSource: null,
        'Net Sales': null,
        'Declared Tips': 0,
        'Non-Cash Tips': 0,
        'Tips Withheld': null,
        'Total Gratuity': null,
        'Employee ID': employeeId || null,
        'Job Code': jobCode || null,
        Location: locationName || null,
        'Location Code': locationCode || null,
      });
    }
    const agg = byEmployeeJob.get(key);
    agg['Regular Hours'] += row.regular_hours || 0;
    agg['Overtime Hours'] += row.overtime_hours || 0;
    if (row.hourly_rate !== null && row.hourly_rate !== undefined) {
      const weight = (row.regular_hours || 0) + (row.overtime_hours || 0) || 1;
      agg.HourlyRateWeightedSum += row.hourly_rate * weight;
      agg.HourlyRateWeight += weight;
      agg.HourlyRateSamples += 1;
    }

    agg['Regular Pay'] += row.regular_pay || 0;
    agg['Overtime Pay'] += row.overtime_pay || 0;
    agg.TotalPayFromSource = sumNullable(agg.TotalPayFromSource, row.total_pay);
    agg['Net Sales'] = sumNullable(agg['Net Sales'], row.net_sales);
    agg['Declared Tips'] += row.declared_tips || 0;
    agg['Non-Cash Tips'] += row.non_cash_tips || 0;
    agg['Tips Withheld'] = sumNullable(agg['Tips Withheld'], row.tips_withheld);
    agg['Total Gratuity'] = sumNullable(agg['Total Gratuity'], row.total_gratuity);
  }

  const result = Array.from(byEmployeeJob.values()).map((agg) => {
    const hourlyRate =
      agg.HourlyRateSamples > 0 && agg.HourlyRateWeight > 0
        ? agg.HourlyRateWeightedSum / agg.HourlyRateWeight
        : null;

    const derivedRegularPay = agg['Regular Pay'] || ((agg['Regular Hours'] || 0) * (hourlyRate || 0));
    const derivedOvertimePay = agg['Overtime Pay'] || ((agg['Overtime Hours'] || 0) * (hourlyRate || 0) * 1.5);
    const totalPay = agg.TotalPayFromSource !== null ? agg.TotalPayFromSource : derivedRegularPay + derivedOvertimePay;
    const totalTips = (agg['Declared Tips'] || 0) + (agg['Non-Cash Tips'] || 0);

    return {
      Employee: agg.Employee,
      'Job Title': agg['Job Title'],
      'Regular Hours': Number((agg['Regular Hours'] || 0).toFixed(2)),
      'Overtime Hours': Number((agg['Overtime Hours'] || 0).toFixed(2)),
      'Hourly Rate': hourlyRate !== null ? Number(hourlyRate.toFixed(2)) : null,
      'Regular Pay': Number((derivedRegularPay || 0).toFixed(2)),
      'Overtime Pay': Number((derivedOvertimePay || 0).toFixed(2)),
      'Total Pay': Number((totalPay || 0).toFixed(2)),
      'Net Sales': agg['Net Sales'] !== null ? Number(agg['Net Sales'].toFixed(2)) : null,
      'Declared Tips': Number((agg['Declared Tips'] || 0).toFixed(2)),
      'Non-Cash Tips': Number((agg['Non-Cash Tips'] || 0).toFixed(2)),
      'Total Tips': Number(totalTips.toFixed(2)),
      'Tips Withheld': agg['Tips Withheld'] !== null ? Number(agg['Tips Withheld'].toFixed(2)) : null,
      'Total Gratuity': agg['Total Gratuity'] !== null ? Number(agg['Total Gratuity'].toFixed(2)) : null,
      'Employee ID': agg['Employee ID'],
      'Job Code': agg['Job Code'],
      Location: agg.Location,
      'Location Code': agg['Location Code'],
    };
  });

  result.sort((a, b) => {
    const empId = String(a['Employee ID'] || '').localeCompare(String(b['Employee ID'] || ''));
    if (empId !== 0) return empId;
    const emp = String(a.Employee || '').localeCompare(String(b.Employee || ''));
    if (emp !== 0) return emp;
    const jobCode = String(a['Job Code'] || '').localeCompare(String(b['Job Code'] || ''));
    if (jobCode !== 0) return jobCode;
    const jobTitle = String(a['Job Title'] || '').localeCompare(String(b['Job Title'] || ''));
    if (jobTitle !== 0) return jobTitle;
    const location = String(a.Location || '').localeCompare(String(b.Location || ''));
    if (location !== 0) return location;
    return String(a['Location Code'] || '').localeCompare(String(b['Location Code'] || ''));
  });

  return result;
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
  const detailRows = rawRows.map((row) => normalizeTimeEntry(row, { location, periodStart: start, periodEnd: end }));
  const rows = buildPayrollExportRows(detailRows, vitalsRecord['Toast Location ID'] ? String(vitalsRecord['Toast Location ID']) : null);
  const columns = [
    'Employee',
    'Job Title',
    'Regular Hours',
    'Overtime Hours',
    'Hourly Rate',
    'Regular Pay',
    'Overtime Pay',
    'Total Pay',
    'Net Sales',
    'Declared Tips',
    'Non-Cash Tips',
    'Total Tips',
    'Tips Withheld',
    'Total Gratuity',
    'Employee ID',
    'Job Code',
    'Location',
    'Location Code',
  ];

  return {
    location_name: location,
    period_start: start,
    period_end: end,
    source: {
      provider: 'toast',
      api_mode: 'standard_time_entries_reconstructed_for_payroll_export',
      label: 'Toast Labor /timeEntries transformed to payroll-export-like rows',
      row_grain: 'one row per Employee ID + Employee Name + Job Code + Job Title + Location + Location Code for selected pay period',
      exact_payroll_export_endpoint_available: false,
      note:
        'Direct Toast Payroll Export endpoint is not configured in this codebase; data is reconstructed from labor/v1/timeEntries and aggregated to payroll-export grain.',
      approximation_notes: [
        'Hourly Rate is a weighted average of available time-entry rates.',
        'Regular Pay and Overtime Pay are summed from source when available, otherwise derived from hours x rate.',
        'Total Pay is summed from source when available, otherwise derived as Regular Pay + Overtime Pay.',
        'Net Sales, Tips Withheld, and Total Gratuity are included only when present in source rows; otherwise null.',
      ],
    },
    row_count: rows.length,
    columns,
    rows,
  };
}

module.exports = {
  fetchOriginalToastPayPeriodData,
};
