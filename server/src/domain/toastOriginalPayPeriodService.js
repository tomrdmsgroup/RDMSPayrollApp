// server/src/domain/toastOriginalPayPeriodService.js
//
// Fetches Toast pay period rows for staff audit view, shaped to resemble
// Toast Payroll Export CSV output as closely as possible from available APIs.

const { fetchVitalsSnapshot } = require('../providers/vitalsProvider');
const { fetchToastAnalyticsJobsFromVitals, fetchToastEmployeesFromVitals } = require('../providers/toastProvider');

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

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.results)) return payload.results;
  return [];
}

function safeTrim(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

function fullNameFromParts(first, last) {
  return [safeTrim(first), safeTrim(last)].filter(Boolean).join(' ').trim() || null;
}

function normalizeEmployeeIdentity(row) {
  const employeeId =
    safeTrim(
      pick(row, [
        'id',
        'guid',
        'employeeId',
        'employeeGuid',
        'externalEmployeeId',
        'payrollEmployeeId',
      ])
    ) || null;

  const externalEmployeeId = safeTrim(pick(row, ['externalEmployeeId', 'employeeNumber', 'employeeCode']));

  const employeeName =
    safeTrim(
      pick(row, [
        'fullName',
        'name',
        'displayName',
        'chosenName',
        'employeeName',
        'lastNameFirstName',
      ])
    ) || fullNameFromParts(row?.firstName, row?.lastName);

  return {
    employee_id: employeeId,
    external_employee_id: externalEmployeeId,
    employee_name: employeeName,
  };
}

function buildEmployeeIndex(employeeRows) {
  const byKey = new Map();
  for (const row of employeeRows) {
    const identity = normalizeEmployeeIdentity(row);
    const keys = [identity.employee_id, identity.external_employee_id].filter(Boolean).map((x) => String(x).toLowerCase());
    for (const key of keys) {
      if (!byKey.has(key)) byKey.set(key, identity);
    }
  }
  return byKey;
}

function normalizeAnalyticsLaborRow(row, { location, periodStart, periodEnd, fallbackLocationCode }) {
  const analyticsEmployeeId = safeTrim(
    pick(row, [
      'employeeGuid',
      'employeeId',
      'employeeUUID',
      'employee.id',
      'employee.guid',
      'employee.employeeId',
    ])
  );
  const analyticsExternalEmployeeId = safeTrim(
    pick(row, [
      'employeeExternalId',
      'externalEmployeeId',
      'employee.externalEmployeeId',
      'employee.employeeCode',
      'employee.employeeNumber',
    ])
  );

  const analyticsEmployeeName =
    safeTrim(
      pick(row, [
        'employeeName',
        'employeeFullName',
        'fullName',
        'name',
        'employee.fullName',
        'employee.name',
      ])
    ) || fullNameFromParts(pick(row, ['employee.firstName', 'firstName']), pick(row, ['employee.lastName', 'lastName']));

  const jobCode =
    safeTrim(
      pick(row, [
        'jobCode',
        'jobId',
        'jobGuid',
        'departmentCode',
        'departmentGuid',
        'job.id',
        'job.guid',
        'job.code',
      ])
    ) || null;

  const jobTitle =
    safeTrim(
      pick(row, [
        'jobName',
        'jobTitle',
        'job',
        'departmentName',
        'department',
        'laborDepartmentName',
        'job.name',
        'job.title',
      ])
    ) || null;

  const locationCode = safeTrim(
    pick(row, ['locationId', 'locationCode', 'restaurantGuid', 'restaurantExternalId', 'location.id', 'location.guid'])
  );
  const locationName = safeTrim(pick(row, ['locationName', 'restaurantName', 'location.name', 'location.displayName'])) || location;
  const businessDate = normalizeBusinessDate(
    pick(row, ['businessDate', 'business_date', 'date', 'workDate', 'shiftDate', 'day', 'reportDate'])
  );
  const payType = safeTrim(
    pick(row, ['payType', 'wageType', 'earningType', 'compensationType', 'pay.type', 'wage.type'])
  );

  return {
    location_name: location,
    location_code: locationCode || fallbackLocationCode || null,
    location_display_name: locationName || location,
    business_date: businessDate,
    pay_type: payType,
    pay_period_start: periodStart,
    pay_period_end: periodEnd,
    employee_id: analyticsEmployeeId,
    external_employee_id: analyticsExternalEmployeeId,
    employee_name: analyticsEmployeeName,
    job_code: jobCode,
    job_name: jobTitle,
    regular_hours: toNum(pick(row, ['regularHours', 'hoursRegular', 'hours'])) || 0,
    overtime_hours: toNum(pick(row, ['overtimeHours', 'otHours'])) || 0,
    hourly_rate: toNum(pick(row, ['hourlyRate', 'payRate', 'rate'])),
    regular_pay: toNum(pick(row, ['regularPay', 'regularCost', 'wageCost', 'laborCost'])) || 0,
    overtime_pay: toNum(pick(row, ['overtimePay', 'overtimeCost', 'otCost'])) || 0,
    total_pay: toNum(pick(row, ['totalPay', 'grossPay', 'totalLaborCost'])),
    net_sales: toNum(pick(row, ['netSales', 'salesNet'])),
    declared_tips: toNum(pick(row, ['declaredTips', 'tipsDeclared'])) || 0,
    non_cash_tips: toNum(pick(row, ['nonCashTips', 'chargedTips', 'tipsNonCash'])) || 0,
    tips_withheld: toNum(pick(row, ['tipsWithheld', 'withheldTips'])),
    total_gratuity: toNum(pick(row, ['totalGratuity', 'gratuity', 'autoGratuity'])),
  };
}

function sumNullable(current, next) {
  if (next === null || next === undefined) return current;
  return (current || 0) + next;
}

function normalizeGroupPart(value, fallback = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function normalizeBusinessDate(value) {
  const raw = safeTrim(value);
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return raw;
}

function joinLaborRowsToEmployees(laborRows, employeeByKey) {
  return laborRows.map((row) => {
    const lookupKeys = [row.employee_id, row.external_employee_id]
      .filter(Boolean)
      .map((x) => String(x).toLowerCase());
    const matched = lookupKeys.map((k) => employeeByKey.get(k)).find(Boolean) || null;
    return {
      ...row,
      employee_id: matched?.employee_id || row.employee_id || null,
      employee_name: matched?.employee_name || row.employee_name || row.employee_id || null,
      toast_employee_id: matched?.employee_id || row.employee_id || null,
      export_employee_id: matched?.external_employee_id || matched?.employee_id || row.employee_id || null,
    };
  });
}

function buildPayrollExportRows(detailRows, fallbackLocationCode = null) {
  const byEmployeeJobLocation = new Map();
  for (const row of detailRows) {
    const employeeName = String(row.employee_name || '').trim();
    const employeeId = String(row.employee_id || '').trim();
    const toastEmployeeId = String(row.toast_employee_id || employeeId || '').trim();
    const exportEmployeeId = String(row.export_employee_id || employeeId || '').trim();
    const jobTitle = String(row.job_name || '').trim();
    const jobCode = String(row.job_code || '').trim();
    const locationName = row.location_display_name || row.location_name || '';
    const locationCode = row.location_code || fallbackLocationCode || '';
    const employeeKey = normalizeGroupPart(toastEmployeeId, normalizeGroupPart(employeeId, '__unknown_employee__'));
    const jobKey = normalizeGroupPart(jobTitle, normalizeGroupPart(jobCode, '__unassigned_job__'));
    const locationKey = normalizeGroupPart(locationCode, normalizeGroupPart(locationName, '__unknown_location__'));
    const key = [employeeKey, jobKey, locationKey].join('|||');

    if (!byEmployeeJobLocation.has(key)) {
      byEmployeeJobLocation.set(key, {
        'Toast Employee ID': toastEmployeeId || null,
        Employee: employeeName || toastEmployeeId || null,
        'Job Title': jobTitle || jobCode || 'Unassigned',
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
        'Employee ID': exportEmployeeId || toastEmployeeId || null,
        'Job Code': jobCode || null,
        Location: locationName || null,
        'Location Code': locationCode || null,
      });
    }

    const agg = byEmployeeJobLocation.get(key);
    if (!agg['Toast Employee ID'] && toastEmployeeId) agg['Toast Employee ID'] = toastEmployeeId;
    if (!agg.Employee && employeeName) agg.Employee = employeeName;
    if (!agg['Employee ID'] && exportEmployeeId) agg['Employee ID'] = exportEmployeeId;
    if ((!agg['Job Title'] || agg['Job Title'] === 'Unassigned') && jobTitle) agg['Job Title'] = jobTitle;
    if (!agg['Job Code'] && jobCode) agg['Job Code'] = jobCode;
    if (!agg.Location && locationName) agg.Location = locationName;
    if (!agg['Location Code'] && locationCode) agg['Location Code'] = locationCode;

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

  const result = Array.from(byEmployeeJobLocation.values()).map((agg) => {
    const hourlyRate =
      agg.HourlyRateSamples > 0 && agg.HourlyRateWeight > 0
        ? agg.HourlyRateWeightedSum / agg.HourlyRateWeight
        : null;

    const derivedRegularPay = agg['Regular Pay'] || ((agg['Regular Hours'] || 0) * (hourlyRate || 0));
    const derivedOvertimePay = agg['Overtime Pay'] || ((agg['Overtime Hours'] || 0) * (hourlyRate || 0) * 1.5);
    const totalPay = agg.TotalPayFromSource !== null ? agg.TotalPayFromSource : derivedRegularPay + derivedOvertimePay;
    const totalTips = (agg['Declared Tips'] || 0) + (agg['Non-Cash Tips'] || 0);

    return {
      'Toast Employee ID': agg['Toast Employee ID'],
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
    const jobTitle = String(a['Job Title'] || '').localeCompare(String(b['Job Title'] || ''));
    if (jobTitle !== 0) return jobTitle;
    const jobCode = String(a['Job Code'] || '').localeCompare(String(b['Job Code'] || ''));
    if (jobCode !== 0) return jobCode;
    const location = String(a.Location || '').localeCompare(String(b.Location || ''));
    if (location !== 0) return location;
    return String(a['Location Code'] || '').localeCompare(String(b['Location Code'] || ''));
  });

  return result;
}

function detectReturnedRowGrain(rows) {
  const hasJobSplit = rows.some((row) => {
    const title = safeTrim(row['Job Title']);
    const code = safeTrim(row['Job Code']);
    return (title && title.toLowerCase() !== 'unassigned') || !!code;
  });
  const hasLocationSplit = rows.some((row) => {
    const name = safeTrim(row.Location);
    const code = safeTrim(row['Location Code']);
    return !!(name || code);
  });

  if (hasJobSplit && hasLocationSplit) return 'one row per Employee + Job Title + Location for selected pay period';
  if (hasJobSplit) return 'one row per Employee + Job Title (location approximated) for selected pay period';
  return 'one row per Employee (job/location not reliably returned by analytics payload) for selected pay period';
}

async function fetchOriginalToastPayPeriodData({ locationName, periodStart, periodEnd }) {
  const location = String(locationName || '').trim();
  const start = String(periodStart || '').trim();
  const end = String(periodEnd || '').trim();
  if (!location || !start || !end) throw new Error('missing_required_fields');

  const snapshot = await fetchVitalsSnapshot(location);
  const vitalsRecord = (snapshot && snapshot.data && snapshot.data[0]) || null;
  if (!vitalsRecord) throw new Error('toast_vitals_not_found');

  const [employees, analytics] = await Promise.all([
    fetchToastEmployeesFromVitals({ vitalsRecord, locationName: location }),
    fetchToastAnalyticsJobsFromVitals({
      vitalsRecord,
      periodStart: start,
      periodEnd: end,
      locationName: location,
    }),
  ]);

  if (!employees.ok) {
    throw new Error(`toast_employees_failed:${employees.error || 'unknown'}:${formatAnalyticsError(employees)}`);
  }

  if (!analytics.ok) {
    throw new Error(`toast_analytics_failed:${analytics.error || 'unknown'}:${formatAnalyticsError(analytics)}`);
  }

  const employeeRows = extractRows(employees.data);
  const employeeByKey = buildEmployeeIndex(employeeRows);
  const rawAnalyticsRows = extractRows(analytics.data);
  const normalizedLaborRows = rawAnalyticsRows.map((row) =>
    normalizeAnalyticsLaborRow(row, {
      location,
      periodStart: start,
      periodEnd: end,
      fallbackLocationCode: vitalsRecord['Toast Location ID'] ? String(vitalsRecord['Toast Location ID']) : null,
    })
  );
  const joinedRows = joinLaborRowsToEmployees(normalizedLaborRows, employeeByKey);
  const rows = buildPayrollExportRows(
    joinedRows,
    vitalsRecord['Toast Location ID'] ? String(vitalsRecord['Toast Location ID']) : null
  );
  const rowGrain = detectReturnedRowGrain(rows);

  const columns = [
    'Toast Employee ID',
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
      api_mode: 'standard_employees_plus_analytics_jobs_reconstructed_for_payroll_export',
      label: 'Toast Standard employees joined to Toast Analytics labor jobs and aggregated to payroll-export-like rows',
      source_row_grain_before_transform: 'one row per Toast ERA labor row grouped by EMPLOYEE for selected period',
      employee_identity_source: 'Toast Standard labor/hr employees endpoint',
      labor_totals_source: 'Toast Analytics ERA labor report (groupBy: EMPLOYEE) for selected pay period',
      join_key_between_sources:
        'analytics.employeeGuid/employeeId + analytics.employeeExternalId -> standard employee id/externalEmployeeId (case-insensitive string match)',
      grouping_key_after_transform: 'lower(toast_employee_id), lower(job_title OR job_code), lower(location_code OR location_name)',
      row_grain_target: 'one row per Employee + Job + Location for selected pay period',
      row_grain_returned: rowGrain,
      exact_payroll_export_endpoint_available: false,
      note:
        'Direct Toast Payroll Export endpoint is not configured in this codebase; data is reconstructed from Standard employees + Analytics labor rows.',
      approximation_notes: [
        'Toast ERA create rejects multi-groupBy requests; this flow uses groupBy EMPLOYEE and reconstructs job/location only from fields present in returned rows.',
        'Hourly Rate is a weighted average of available analytics rates.',
        'Regular Pay and Overtime Pay are summed from analytics rows when present, otherwise derived from hours x rate.',
        'Total Pay is summed from source when available, otherwise derived as Regular Pay + Overtime Pay.',
        'Columns absent from analytics payload remain null or derived approximations.',
      ],
    },
    row_count: rows.length,
    columns,
    rows,
  };
}

module.exports = {
  fetchOriginalToastPayPeriodData,
  __test: {
    normalizeEmployeeIdentity,
    normalizeAnalyticsLaborRow,
    joinLaborRowsToEmployees,
    buildPayrollExportRows,
  },
};
