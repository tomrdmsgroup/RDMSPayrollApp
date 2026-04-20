// server/src/domain/toastOriginalPayPeriodService.js
//
// Fetches Toast pay period rows for staff audit view, shaped to resemble
// Toast Payroll Export CSV output as closely as possible from available APIs.

const { fetchVitalsSnapshot } = require('../providers/vitalsProvider');
const {
  fetchToastAnalyticsJobsFromVitals,
  fetchToastEmployeesFromVitals,
  fetchToastTimeEntriesFromVitals,
} = require('../providers/toastProvider');
const inFlightPayPeriodLoads = new Map();

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
  const toastEmployeeId =
    safeTrim(
      pick(row, [
        'id',
        'guid',
        'employeeId',
        'employee_id',
        'employeeGuid',
        'employee_guid',
        'employeeUuid',
        'uuid',
        'employee.uuid',
      ])
    ) || null;

  const payrollEmployeeId = safeTrim(
    pick(row, [
      'payrollEmployeeId',
      'payrollId',
      'payrollEmployeeNumber',
      'payrollNumber',
      'employeeNumber',
      'employeeCode',
      'employee_code',
      'externalEmployeeId',
      'external_employee_id',
      'externalId',
      'external_id',
      'posEmployeeId',
      'pos_employee_id',
    ])
  );

  const employeeName =
    safeTrim(
      pick(row, [
        'fullName',
        'name',
        'displayName',
        'chosenName',
        'employeeName',
        'employee_name',
        'lastNameFirstName',
      ])
    ) || fullNameFromParts(row?.firstName, row?.lastName);

  return {
    employee_id: toastEmployeeId,
    external_employee_id: payrollEmployeeId,
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
      'employee_guid',
      'employeeId',
      'employee_id',
      'employeeUUID',
      'employee.id',
      'employee.guid',
      'employee.employeeId',
    ])
  );
  const analyticsExternalEmployeeId = safeTrim(
    pick(row, [
      'employeeExternalId',
      'employee_external_id',
      'externalEmployeeId',
      'external_employee_id',
      'employee.externalEmployeeId',
      'employee.external_employee_id',
      'employee.employeeCode',
      'employee.employeeNumber',
    ])
  );

  const analyticsEmployeeName =
    safeTrim(
      pick(row, [
        'employeeName',
        'employee_name',
        'employeeFullName',
        'employee_full_name',
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
        'job_code',
        'jobId',
        'job_id',
        'jobGuid',
        'job_guid',
        'departmentCode',
        'department_code',
        'departmentGuid',
        'department_guid',
        'job.id',
        'job.guid',
        'job.code',
      ])
    ) || null;

  const jobTitle =
    safeTrim(
      pick(row, [
        'jobName',
        'job_name',
        'jobTitle',
        'job_title',
        'job',
        'departmentName',
        'department_name',
        'department',
        'laborDepartmentName',
        'labor_department_name',
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
    regular_hours: toNum(pick(row, ['regularHours', 'regular_hours', 'hoursRegular', 'hours'])) || 0,
    overtime_hours: toNum(pick(row, ['overtimeHours', 'overtime_hours', 'otHours', 'ot_hours'])) || 0,
    hourly_rate: toNum(pick(row, ['hourlyRate', 'hourly_rate', 'payRate', 'pay_rate', 'rate'])),
    regular_pay: toNum(pick(row, ['regularPay', 'regular_pay', 'regularCost', 'regular_cost', 'wageCost', 'laborCost'])) || 0,
    overtime_pay: toNum(pick(row, ['overtimePay', 'overtime_pay', 'overtimeCost', 'overtime_cost', 'otCost', 'ot_cost'])) || 0,
    total_pay: toNum(pick(row, ['totalPay', 'total_pay', 'grossPay', 'gross_pay', 'totalLaborCost', 'total_labor_cost'])),
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

function sampleRows(rows, limit = 5) {
  return (Array.isArray(rows) ? rows : []).slice(0, limit);
}

function collectFieldPaths(value, prefix = '', out = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return out;
  if (Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(path);
    if (v && typeof v === 'object' && !Array.isArray(v)) collectFieldPaths(v, path, out, depth + 1);
  }
  return out;
}

function sourceShapeDebug({ label, rows, requiredFieldHints = {}, naturalGrainHint }) {
  const sample = sampleRows(rows, 40);
  const fieldSet = new Set();
  for (const row of sample) collectFieldPaths(row, '', fieldSet);
  const fields = Array.from(fieldSet.values()).sort();
  const available = {};
  const missing = {};
  for (const [k, hints] of Object.entries(requiredFieldHints)) {
    const hit = hints.filter((candidate) => fields.includes(candidate));
    available[k] = hit;
    missing[k] = hints.filter((candidate) => !hit.includes(candidate));
  }
  return {
    label,
    sample_row_count: sample.length,
    discovered_fields_sample: fields.slice(0, 150),
    available_field_candidates: available,
    missing_field_candidates: missing,
    natural_row_grain: naturalGrainHint,
  };
}

function hasAnyField(sourceDebug, key) {
  return Array.isArray(sourceDebug?.available_field_candidates?.[key]) && sourceDebug.available_field_candidates[key].length > 0;
}

function lookupKeysForRow(row) {
  return [row?.employee_id, row?.external_employee_id]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase());
}

function normalizeTimeEntryRow(row, fallbackLocationName = null, fallbackLocationCode = null) {
  const employeeId = safeTrim(
    pick(row, [
      'employeeGuid',
      'employee_guid',
      'employeeId',
      'employee_id',
      'employeeUUID',
      'employee.uuid',
      'employee.id',
      'guid',
      'id',
    ])
  );
  const externalEmployeeId = safeTrim(
    pick(row, [
      'employeeExternalId',
      'employee_external_id',
      'externalEmployeeId',
      'external_employee_id',
      'employee.employeeCode',
      'employee.employeeNumber',
      'employeeNumber',
      'employeeCode',
    ])
  );
  const employeeName =
    safeTrim(
      pick(row, [
        'employeeName',
        'employee_name',
        'employee.fullName',
        'employee.name',
        'name',
        'fullName',
      ])
    ) || fullNameFromParts(pick(row, ['employee.firstName', 'firstName']), pick(row, ['employee.lastName', 'lastName']));

  return {
    employee_id: employeeId,
    external_employee_id: externalEmployeeId,
    employee_name: employeeName,
    business_date: normalizeBusinessDate(
      pick(row, ['businessDate', 'business_date', 'date', 'workDate', 'shiftDate', 'inDate', 'clockInDate'])
    ),
    pay_type: safeTrim(pick(row, ['payType', 'wageType', 'earningType'])),
    job_code: safeTrim(pick(row, ['jobCode', 'job_code', 'job.id', 'job.guid', 'jobId', 'jobGuid'])),
    job_name: safeTrim(pick(row, ['jobName', 'job_name', 'jobTitle', 'job_title', 'job.name', 'job.title'])),
    regular_hours: toNum(pick(row, ['regularHours', 'regular_hours', 'hoursRegular'])),
    overtime_hours: toNum(pick(row, ['overtimeHours', 'overtime_hours', 'otHours', 'ot_hours'])),
    hourly_rate: toNum(pick(row, ['hourlyRate', 'hourly_rate', 'rate', 'payRate', 'wageRate'])),
    regular_pay: toNum(pick(row, ['regularPay', 'regular_pay', 'regularWages', 'regular_cost', 'regularCost'])),
    overtime_pay: toNum(pick(row, ['overtimePay', 'overtime_pay', 'otPay', 'overtime_cost', 'overtimeCost'])),
    total_pay: toNum(pick(row, ['totalPay', 'total_pay', 'grossPay', 'gross_pay', 'wages', 'wageAmount'])),
    net_sales: toNum(pick(row, ['netSales', 'salesNet'])),
    declared_tips: toNum(pick(row, ['declaredTips', 'tipsDeclared'])),
    non_cash_tips: toNum(pick(row, ['nonCashTips', 'chargedTips', 'tipsNonCash'])),
    tips_withheld: toNum(pick(row, ['tipsWithheld', 'withheldTips'])),
    total_gratuity: toNum(pick(row, ['totalGratuity', 'gratuity', 'autoGratuity'])),
    location_display_name:
      safeTrim(
        pick(row, [
          'locationName',
          'location_name',
          'location.displayName',
          'location.name',
          'restaurantName',
          'restaurant',
        ])
      ) || fallbackLocationName,
    location_code:
      safeTrim(
        pick(row, [
          'locationCode',
          'location_code',
          'locationId',
          'location.id',
          'restaurantGuid',
          'restaurantExternalId',
        ])
      ) || fallbackLocationCode,
  };
}

function buildTimeEntryIdentityIndex(timeEntryRows, fallbackLocationName, fallbackLocationCode) {
  const byKey = new Map();
  for (const row of timeEntryRows) {
    const normalized = normalizeTimeEntryRow(row, fallbackLocationName, fallbackLocationCode);
    const keys = [normalized.employee_id, normalized.external_employee_id]
      .filter(Boolean)
      .map((x) => String(x).toLowerCase());
    if (!keys.length) continue;
    const weight = 1;
    for (const key of keys) {
      if (!byKey.has(key)) {
        byKey.set(key, {
          employee_id: normalized.employee_id || null,
          external_employee_id: normalized.external_employee_id || null,
          employee_name: normalized.employee_name || null,
          top_job_name: null,
          top_job_code: null,
          top_location_name: null,
          top_location_code: null,
          jobCounts: new Map(),
          locationCounts: new Map(),
        });
      }
      const target = byKey.get(key);
      if (!target.employee_id && normalized.employee_id) target.employee_id = normalized.employee_id;
      if (!target.external_employee_id && normalized.external_employee_id) target.external_employee_id = normalized.external_employee_id;
      if (!target.employee_name && normalized.employee_name) target.employee_name = normalized.employee_name;
      if (normalized.job_name) {
        const c = target.jobCounts.get(normalized.job_name) || 0;
        target.jobCounts.set(normalized.job_name, c + weight);
      }
      if (normalized.location_display_name) {
        const c = target.locationCounts.get(normalized.location_display_name) || 0;
        target.locationCounts.set(normalized.location_display_name, c + weight);
      }
      if (!target.top_job_code && normalized.job_code) target.top_job_code = normalized.job_code;
      if (!target.top_location_code && normalized.location_code) target.top_location_code = normalized.location_code;
    }
  }

  for (const info of byKey.values()) {
    info.top_job_name = Array.from(info.jobCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    info.top_location_name = Array.from(info.locationCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    delete info.jobCounts;
    delete info.locationCounts;
  }

  return byKey;
}

function buildExportShapedRowsFromTimeEntries({
  timeEntryRows,
  employeeByKey,
  fallbackLocationName,
  fallbackLocationCode,
  periodStart,
  periodEnd,
}) {
  return timeEntryRows.map((row) => {
    const normalized = normalizeTimeEntryRow(row, fallbackLocationName, fallbackLocationCode);
    const keys = lookupKeysForRow(normalized);
    const employeeMatch = keys.map((k) => employeeByKey.get(k)).find(Boolean) || null;
    return {
      location_name: fallbackLocationName,
      location_code: normalized.location_code || fallbackLocationCode || null,
      location_display_name: normalized.location_display_name || fallbackLocationName || null,
      business_date: normalized.business_date,
      pay_type: normalized.pay_type,
      pay_period_start: periodStart,
      pay_period_end: periodEnd,
      employee_id: employeeMatch?.employee_id || normalized.employee_id || null,
      external_employee_id: employeeMatch?.external_employee_id || normalized.external_employee_id || null,
      employee_name: employeeMatch?.employee_name || normalized.employee_name || null,
      toast_employee_id: employeeMatch?.employee_id || normalized.employee_id || null,
      export_employee_id: employeeMatch?.external_employee_id || normalized.external_employee_id || null,
      job_code: normalized.job_code,
      job_name: normalized.job_name,
      regular_hours: normalized.regular_hours || 0,
      overtime_hours: normalized.overtime_hours || 0,
      hourly_rate: normalized.hourly_rate,
      regular_pay: normalized.regular_pay || 0,
      overtime_pay: normalized.overtime_pay || 0,
      total_pay: normalized.total_pay,
      net_sales: normalized.net_sales,
      declared_tips: normalized.declared_tips || 0,
      non_cash_tips: normalized.non_cash_tips || 0,
      tips_withheld: normalized.tips_withheld,
      total_gratuity: normalized.total_gratuity,
    };
  });
}

function buildJoinDiagnostics({ employeeRows, employeeByKey, rawAnalyticsRows, normalizedLaborRows }) {
  const normalizedEmployeeRows = sampleRows(employeeRows, 25).map((row) => normalizeEmployeeIdentity(row));
  const normalizedAnalyticsRows = sampleRows(rawAnalyticsRows, 25).map((row) =>
    normalizeAnalyticsLaborRow(row, {
      location: safeTrim(pick(row, ['locationName', 'restaurantName'])) || null,
      periodStart: safeTrim(pick(row, ['startBusinessDate'])) || null,
      periodEnd: safeTrim(pick(row, ['endBusinessDate'])) || null,
      fallbackLocationCode: null,
    })
  );

  const joinedStats = {
    total_analytics_rows: normalizedLaborRows.length,
    matched_rows: 0,
    unmatched_rows: 0,
    match_rate: 0,
  };

  const unmatchedSamples = [];
  const joinKeySamples = [];

  for (const row of normalizedLaborRows) {
    const keys = lookupKeysForRow(row);
    const match = keys.map((k) => employeeByKey.get(k)).find(Boolean) || null;
    if (match) {
      joinedStats.matched_rows += 1;
    } else {
      joinedStats.unmatched_rows += 1;
      if (unmatchedSamples.length < 10) unmatchedSamples.push(row);
    }
    if (joinKeySamples.length < 25) {
      joinKeySamples.push({
        analytics_lookup_keys: keys,
        matched_employee_id: match?.employee_id || null,
        matched_external_employee_id: match?.external_employee_id || null,
      });
    }
  }

  if (joinedStats.total_analytics_rows > 0) {
    joinedStats.match_rate = Number(((joinedStats.matched_rows / joinedStats.total_analytics_rows) * 100).toFixed(2));
  }

  return {
    sample_raw_employee_rows: sampleRows(employeeRows, 5),
    sample_raw_analytics_rows: sampleRows(rawAnalyticsRows, 5),
    sample_normalized_employee_identity: normalizedEmployeeRows.slice(0, 10),
    sample_normalized_analytics_labor: normalizedAnalyticsRows.slice(0, 10),
    employee_index_key_sample: Array.from(employeeByKey.keys()).slice(0, 30),
    analytics_join_key_sample: joinKeySamples,
    join_summary: joinedStats,
    unmatched_analytics_rows_sample: unmatchedSamples,
  };
}

function joinLaborRowsToEmployees(laborRows, employeeByKey, timeEntryByKey = new Map()) {
  return laborRows.map((row) => {
    const lookupKeys = [row.employee_id, row.external_employee_id]
      .filter(Boolean)
      .map((x) => String(x).toLowerCase());
    const matched = lookupKeys.map((k) => employeeByKey.get(k)).find(Boolean) || null;
    const timeEntryMatch = lookupKeys.map((k) => timeEntryByKey.get(k)).find(Boolean) || null;
    return {
      ...row,
      employee_id: matched?.employee_id || timeEntryMatch?.employee_id || row.employee_id || null,
      employee_name: matched?.employee_name || timeEntryMatch?.employee_name || row.employee_name || null,
      toast_employee_id: matched?.employee_id || timeEntryMatch?.employee_id || row.employee_id || null,
      export_employee_id: matched?.external_employee_id || timeEntryMatch?.external_employee_id || row.external_employee_id || null,
      job_name: row.job_name || timeEntryMatch?.top_job_name || null,
      job_code: row.job_code || timeEntryMatch?.top_job_code || null,
      location_display_name: row.location_display_name || timeEntryMatch?.top_location_name || row.location_name || null,
      location_code: row.location_code || timeEntryMatch?.top_location_code || null,
    };
  });
}

function buildPayrollExportRows(detailRows, fallbackLocationCode = null) {
  const byEmployeeJobLocation = new Map();
  for (const row of detailRows) {
    const employeeName = String(row.employee_name || '').trim();
    const employeeId = String(row.employee_id || '').trim();
    const toastEmployeeId = String(row.toast_employee_id || employeeId || '').trim();
    const exportEmployeeId = String(row.export_employee_id || '').trim();
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
        Employee: employeeName || null,
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
        'Employee ID': exportEmployeeId || null,
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

async function fetchOriginalToastPayPeriodData({ locationName, periodStart, periodEnd, includeDebug = false }) {
  const location = String(locationName || '').trim();
  const start = String(periodStart || '').trim();
  const end = String(periodEnd || '').trim();
  if (!location || !start || !end) throw new Error('missing_required_fields');

  const inflightKey = `${location.toLowerCase()}|${start}|${end}`;
  if (inFlightPayPeriodLoads.has(inflightKey)) {
    return inFlightPayPeriodLoads.get(inflightKey);
  }

  const loadPromise = (async () => {
    const snapshot = await fetchVitalsSnapshot(location);
    const vitalsRecord = (snapshot && snapshot.data && snapshot.data[0]) || null;
    if (!vitalsRecord) throw new Error('toast_vitals_not_found');

    const [employees, analytics, timeEntries] = await Promise.all([
      fetchToastEmployeesFromVitals({ vitalsRecord, locationName: location }),
      fetchToastAnalyticsJobsFromVitals({
        vitalsRecord,
        periodStart: start,
        periodEnd: end,
        locationName: location,
      }),
      fetchToastTimeEntriesFromVitals({
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
    const timeEntryRows = timeEntries && timeEntries.ok ? extractRows(timeEntries.data) : [];
    const timeEntryByKey = buildTimeEntryIdentityIndex(
      timeEntryRows,
      location,
      vitalsRecord['Toast Location ID'] ? String(vitalsRecord['Toast Location ID']) : null
    );
    const rawAnalyticsRows = extractRows(analytics.data);
    const normalizedLaborRows = rawAnalyticsRows.map((row) =>
      normalizeAnalyticsLaborRow(row, {
        location,
        periodStart: start,
        periodEnd: end,
        fallbackLocationCode: vitalsRecord['Toast Location ID'] ? String(vitalsRecord['Toast Location ID']) : null,
      })
    );
    const employeesShape = sourceShapeDebug({
      label: 'toast_standard_employees',
      rows: employeeRows,
      requiredFieldHints: {
        employee_name: ['fullName', 'name', 'firstName', 'lastName'],
        payroll_employee_id: ['payrollEmployeeId', 'employeeNumber', 'externalEmployeeId'],
      },
      naturalGrainHint: 'one row per employee',
    });
    const timeEntriesShape = sourceShapeDebug({
      label: 'toast_standard_time_entries',
      rows: timeEntryRows,
      requiredFieldHints: {
        employee_name: ['employeeName', 'employee.fullName'],
        payroll_employee_id: ['employeeExternalId', 'employee.employeeNumber', 'employee.employeeCode'],
        job_title_or_code: ['jobName', 'jobTitle', 'jobCode', 'job.name'],
        location_text_or_code: ['locationName', 'location.displayName', 'locationCode', 'locationId'],
        regular_or_ot_hours: ['regularHours', 'overtimeHours', 'hours'],
        pay_amounts: ['regularPay', 'overtimePay', 'totalPay', 'wages'],
      },
      naturalGrainHint: 'one row per time entry / punch segment (employee + job + location when populated)',
    });
    const analyticsShape = sourceShapeDebug({
      label: 'toast_analytics_labor_grouped_employee',
      rows: rawAnalyticsRows,
      requiredFieldHints: {
        employee_name: ['employeeName', 'employeeFullName', 'employee.firstName', 'employee.lastName'],
        payroll_employee_id: ['employeeExternalId', 'externalEmployeeId'],
        job_title_or_code: ['jobName', 'jobTitle', 'jobCode', 'departmentName'],
        location_text_or_code: ['locationName', 'locationCode', 'restaurantName'],
        regular_or_ot_hours: ['regularHours', 'overtimeHours'],
        pay_amounts: ['regularPay', 'overtimePay', 'totalPay', 'regularCost', 'totalLaborCost'],
      },
      naturalGrainHint: 'employee-grouped summary rows (ERA groupBy EMPLOYEE)',
    });

    const canTimeEntriesShapeRows =
      hasAnyField(timeEntriesShape, 'job_title_or_code') && hasAnyField(timeEntriesShape, 'location_text_or_code');
    const strategy = canTimeEntriesShapeRows ? 'time_entries_primary_with_employee_enrichment' : 'analytics_primary_fallback';

    const sourceDetailRows =
      strategy === 'time_entries_primary_with_employee_enrichment'
        ? buildExportShapedRowsFromTimeEntries({
            timeEntryRows,
            employeeByKey,
            fallbackLocationName: location,
            fallbackLocationCode: vitalsRecord['Toast Location ID'] ? String(vitalsRecord['Toast Location ID']) : null,
            periodStart: start,
            periodEnd: end,
          })
        : joinLaborRowsToEmployees(normalizedLaborRows, employeeByKey, timeEntryByKey);

    const rows = buildPayrollExportRows(
      sourceDetailRows,
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

    const debug = includeDebug
      ? {
          join_diagnostics: buildJoinDiagnostics({
            employeeRows,
            employeeByKey,
            rawAnalyticsRows,
            normalizedLaborRows,
          }),
          source_shape_diagnostics: {
            employees: employeesShape,
            time_entries: timeEntriesShape,
            analytics_employee_grouped: analyticsShape,
          },
          source_strategy_selected: strategy,
          source_strategy_reason:
            strategy === 'time_entries_primary_with_employee_enrichment'
              ? 'Standard time entries expose job/location fields, so row grain is built from time entries and employee names/IDs are enriched from Standard employees.'
              : 'Time entries do not expose sufficient job/location fields in sampled payload; fallback uses analytics employee-grouped reconstruction.',
        }
      : null;

    return {
      location_name: location,
      period_start: start,
      period_end: end,
      source: {
        provider: 'toast',
        api_mode: strategy,
        label:
          strategy === 'time_entries_primary_with_employee_enrichment'
            ? 'Toast Standard time entries as primary row-shape source + Standard employee enrichment'
            : 'Toast Standard employees joined to Toast Analytics labor jobs and aggregated to payroll-export-like rows',
        source_row_grain_before_transform:
          strategy === 'time_entries_primary_with_employee_enrichment'
            ? 'one row per Toast Standard time entry for selected period'
            : 'one row per Toast ERA labor row grouped by EMPLOYEE for selected period',
        employee_identity_source: 'Toast Standard labor/hr employees endpoint',
        labor_totals_source:
          strategy === 'time_entries_primary_with_employee_enrichment'
            ? 'Toast Standard labor time entries payload (plus fields available in that payload)'
            : 'Toast Analytics ERA labor report (groupBy: EMPLOYEE) for selected pay period',
        employee_column_mapping: 'Employee column prefers Toast Standard employee full name; falls back to analytics name, then Toast employee id only when no name is available',
        employee_id_column_mapping:
          'Employee ID column prefers payrollEmployeeId/payrollId/payrollEmployeeNumber/employeeNumber/employeeCode/externalEmployeeId from Toast Standard employees; remains blank when unavailable',
        join_key_between_sources:
          'analytics.employeeGuid/employeeId + analytics.employeeExternalId -> standard employee id/externalEmployeeId (case-insensitive string match)',
        grouping_key_after_transform: 'lower(toast_employee_id), lower(job_title OR job_code), lower(location_code OR location_name)',
        row_grain_target: 'one row per Employee + Job + Location for selected pay period',
        row_grain_returned: rowGrain,
        exact_payroll_export_endpoint_available: false,
        note:
          strategy === 'time_entries_primary_with_employee_enrichment'
            ? 'Direct Toast Payroll Export endpoint is not configured in this codebase; rows are primarily shaped from Standard time entries and enriched with Standard employees.'
            : 'Direct Toast Payroll Export endpoint is not configured in this codebase; data is reconstructed from Standard employees + Analytics labor rows.',
        approximation_notes:
          strategy === 'time_entries_primary_with_employee_enrichment'
            ? [
                'Time entries are used for row grain (employee + job + location) when those fields exist in the payload.',
                'Columns not present on time entries remain null/0 or derived approximations after aggregation.',
                'Analytics is still fetched for diagnostics but is not the primary row-shape source in this strategy.',
              ]
            : [
                'Toast ERA create rejects multi-groupBy requests; analytics alone cannot guarantee employee+job+location row grain.',
                'Hourly Rate is a weighted average of available analytics rates.',
                'Regular Pay and Overtime Pay are summed from analytics rows when present, otherwise derived from hours x rate.',
                'Total Pay is summed from source when available, otherwise derived as Regular Pay + Overtime Pay.',
                'Columns absent from analytics payload remain null or derived approximations.',
              ],
      },
      row_count: rows.length,
      columns,
      rows,
      debug,
    };
  })();

  inFlightPayPeriodLoads.set(inflightKey, loadPromise);
  try {
    return await loadPromise;
  } finally {
    inFlightPayPeriodLoads.delete(inflightKey);
  }
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
