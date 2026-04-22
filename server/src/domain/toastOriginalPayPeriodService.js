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
  return `${s.slice(0, maxLen)}...[truncated ${s.length - maxLen} chars]`;
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

function normalizeBusinessDate(value) {
  const raw = safeTrim(value);
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return raw;
}

function sumNullable(current, next) {
  if (next === null || next === undefined) return current;
  return (current || 0) + next;
}

function sampleRows(rows, limit = 5) {
  return (Array.isArray(rows) ? rows : []).slice(0, limit);
}

function sourceTag(sourceName, reason = null) {
  return { source: sourceName || null, reason: reason || null };
}

function pickDominantSource(counter) {
  if (!(counter instanceof Map) || counter.size === 0) return null;
  return Array.from(counter.entries()).sort((a, b) => b[1] - a[1])[0][0];
}

function sourceIsPresent(sourceValue) {
  return !!(sourceValue && typeof sourceValue === 'string' && sourceValue.trim());
}

function normalizeGroupPart(value, fallback = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
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
      'employeePayrollId',
      'employee_payroll_id',
      'employee.externalEmployeeId',
      'employee.external_employee_id',
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
    employee_id: payrollEmployeeId || toastEmployeeId,
    external_employee_id: payrollEmployeeId,
    toast_employee_id: toastEmployeeId,
    employee_name: employeeName,
  };
}

function buildEmployeeLookupKeys(identity) {
  return [identity?.employee_id, identity?.external_employee_id, identity?.toast_employee_id]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase());
}

function buildEmployeeIndex(employeeRows) {
  const byKey = new Map();
  for (const row of employeeRows) {
    const identity = normalizeEmployeeIdentity(row);
    const keys = buildEmployeeLookupKeys(identity);
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
      'employee.payrollEmployeeId',
      'employee.payrollId',
      'employee.employeeCode',
      'employee.employeeNumber',
      'employee.posEmployeeId',
      'employee.posEmployeeNumber',
      'posEmployeeId',
      'posEmployeeNumber',
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
        'job.externalId',
        'job.external_id',
      ])
    ) || null;

  const jobTitle =
    safeTrim(
      pick(row, [
        'jobName',
        'job_name',
        'jobTitle',
        'job_title',
        'job.name',
        'job.title',
        'job.displayName',
        'departmentName',
        'department_name',
        'department',
        'laborDepartmentName',
        'labor_department_name',
      ])
    ) || null;

  const locationCode = safeTrim(
    pick(row, ['locationId', 'locationCode', 'restaurantGuid', 'restaurantExternalId', 'location.id', 'location.guid'])
  );

  const locationName =
    safeTrim(pick(row, ['locationName', 'restaurantName', 'location.name', 'location.displayName'])) || location;

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
    employee_id: analyticsExternalEmployeeId || analyticsEmployeeId,
    external_employee_id: analyticsExternalEmployeeId,
    toast_employee_id: analyticsEmployeeId,
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

function normalizeJobIdentityPart(row) {
  return safeTrim(row?.job_code) || safeTrim(row?.job_name) || null;
}

function buildEmployeeJobCompositeLookupKeys(row) {
  const employeeKeys = buildEmployeeLookupKeys(row);
  const jobPart = normalizeJobIdentityPart(row);
  if (!jobPart) return [];
  const normalizedJobPart = String(jobPart).trim().toLowerCase();
  return employeeKeys.map((employeeKey) => `${employeeKey}|||${normalizedJobPart}`);
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
      'employee.externalEmployeeId',
      'employee.external_employee_id',
      'payrollEmployeeId',
      'payroll_employee_id',
      'payrollId',
      'employee.payrollEmployeeId',
      'employee.payrollId',
      'employee.employeeCode',
      'employee.employeeNumber',
      'employeeNumber',
      'employeeCode',
      'employee.posEmployeeId',
      'employee.posEmployeeNumber',
      'posEmployeeId',
      'posEmployeeNumber',
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
    employee_id: externalEmployeeId || employeeId,
    external_employee_id: externalEmployeeId,
    toast_employee_id: employeeId,
    employee_name: employeeName,
    business_date: normalizeBusinessDate(
      pick(row, ['businessDate', 'business_date', 'date', 'workDate', 'shiftDate', 'inDate', 'clockInDate'])
    ),
    pay_type: safeTrim(pick(row, ['payType', 'wageType', 'earningType'])),
    job_code: safeTrim(
      pick(row, [
        'jobCode',
        'job_code',
        'job.id',
        'job.guid',
        'job.code',
        'job.externalId',
        'job.external_id',
        'jobId',
        'jobGuid',
        'jobUuid',
        'laborJobId',
        'laborJobGuid',
        'departmentId',
        'departmentGuid',
      ])
    ),
    job_name: safeTrim(
      pick(row, [
        'jobName',
        'job_name',
        'jobTitle',
        'job_title',
        'job.name',
        'job.title',
        'job.displayName',
        'laborJobName',
        'laborJobTitle',
        'laborDepartmentName',
        'departmentName',
        'department',
      ])
    ),
    regular_hours: toNum(pick(row, ['regularHours', 'regular_hours', 'hoursRegular'])),
    overtime_hours: toNum(pick(row, ['overtimeHours', 'overtime_hours', 'otHours', 'ot_hours'])),
    hourly_rate: toNum(pick(row, ['hourlyRate', 'hourly_rate', 'rate', 'payRate', 'wageRate', 'baseRate', 'wage.rate'])),
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
  const byCompositeKey = new Map();

  for (const row of timeEntryRows) {
    const normalized = normalizeTimeEntryRow(row, fallbackLocationName, fallbackLocationCode);
    const employeeKeys = buildEmployeeLookupKeys(normalized);
    const jobPart = normalizeJobIdentityPart(normalized);
    if (!employeeKeys.length || !jobPart) continue;

    const normalizedJobPart = String(jobPart).trim().toLowerCase();

    for (const employeeKey of employeeKeys) {
      const compositeKey = `${employeeKey}|||${normalizedJobPart}`;
      if (!byCompositeKey.has(compositeKey)) {
        byCompositeKey.set(compositeKey, {
          employee_id: normalized.employee_id || null,
          external_employee_id: normalized.external_employee_id || null,
          toast_employee_id: normalized.toast_employee_id || null,
          employee_name: normalized.employee_name || null,
          job_name: normalized.job_name || null,
          job_code: normalized.job_code || null,
          location_display_name: normalized.location_display_name || null,
          location_code: normalized.location_code || null,
        });
      }

      const target = byCompositeKey.get(compositeKey);
      if (!target.employee_id && normalized.employee_id) target.employee_id = normalized.employee_id;
      if (!target.external_employee_id && normalized.external_employee_id) target.external_employee_id = normalized.external_employee_id;
      if (!target.toast_employee_id && normalized.toast_employee_id) target.toast_employee_id = normalized.toast_employee_id;
      if (!target.employee_name && normalized.employee_name) target.employee_name = normalized.employee_name;
      if (!target.job_name && normalized.job_name) target.job_name = normalized.job_name;
      if (!target.job_code && normalized.job_code) target.job_code = normalized.job_code;
      if (!target.location_display_name && normalized.location_display_name) target.location_display_name = normalized.location_display_name;
      if (!target.location_code && normalized.location_code) target.location_code = normalized.location_code;
    }
  }

  return byCompositeKey;
}

function buildExportShapedRowsFromTimeEntries({
  timeEntryRows,
  employeeByKey,
  fallbackLocationName,
  fallbackLocationCode,
  periodStart,
  periodEnd,
}) {
  const byCompositeSegment = new Map();

  for (const row of timeEntryRows) {
    const normalized = normalizeTimeEntryRow(row, fallbackLocationName, fallbackLocationCode);
    const employeeKeys = buildEmployeeLookupKeys(normalized);
    const employeeMatch = employeeKeys.map((k) => employeeByKey.get(k)).find(Boolean) || null;

    const exportEmployeeId = employeeMatch?.external_employee_id || normalized.external_employee_id || null;
    const toastEmployeeId = employeeMatch?.toast_employee_id || normalized.toast_employee_id || null;
    const canonicalEmployeeId = exportEmployeeId || employeeMatch?.employee_id || normalized.employee_id || null;

    const departmentKey = normalizeJobIdentityPart(normalized) || '__unassigned_department__';
    const locationKey = String(
      normalized.location_code ||
        normalized.location_display_name ||
        fallbackLocationCode ||
        fallbackLocationName ||
        '__unknown_location__'
    ).toLowerCase();
    const employeeKeyPart = String(canonicalEmployeeId || toastEmployeeId || '__unknown_employee__').toLowerCase();
    const rateKey = normalized.hourly_rate !== null && normalized.hourly_rate !== undefined
      ? String(Number(normalized.hourly_rate).toFixed(4))
      : '';

    const compositeKey = [employeeKeyPart, String(departmentKey).toLowerCase(), locationKey, rateKey].join('|||');

    if (!byCompositeSegment.has(compositeKey)) {
      byCompositeSegment.set(compositeKey, {
        location_name: fallbackLocationName,
        location_code: normalized.location_code || fallbackLocationCode || null,
        location_display_name: normalized.location_display_name || fallbackLocationName || null,
        business_date: normalized.business_date,
        pay_type: normalized.pay_type,
        pay_period_start: periodStart,
        pay_period_end: periodEnd,
        employee_id: canonicalEmployeeId,
        external_employee_id: exportEmployeeId,
        employee_name: employeeMatch?.employee_name || normalized.employee_name || null,
        toast_employee_id: toastEmployeeId,
        export_employee_id: exportEmployeeId,
        department_code: normalized.job_code,
        department_name: normalized.job_name,
        regular_hours: 0,
        overtime_hours: 0,
        hourly_rate_weighted_sum: 0,
        hourly_rate_weight: 0,
        regular_pay: 0,
        overtime_pay: 0,
        total_pay: 0,
        net_sales: 0,
        declared_tips: 0,
        non_cash_tips: 0,
        tips_withheld: 0,
        total_gratuity: 0,
        __field_sources: {
          employee_name: employeeMatch?.employee_name
            ? sourceTag('toast_standard_employees', 'matched_by_employee_id_or_external_id')
            : normalized.employee_name
              ? sourceTag('toast_standard_time_entries', 'employee_name_present_on_time_entry')
              : sourceTag(null),
          department: normalized.job_name
            ? sourceTag('toast_standard_time_entries', 'department_name_present_on_time_entry')
            : normalized.job_code
              ? sourceTag('toast_standard_time_entries', 'department_code_present_on_time_entry')
              : sourceTag(null),
          hourly_rate: normalized.hourly_rate !== null
            ? sourceTag('toast_standard_time_entries', 'hourly_rate_on_time_entry')
            : sourceTag(null),
          employee_id: exportEmployeeId
            ? sourceTag(
                employeeMatch?.external_employee_id ? 'toast_standard_employees' : 'toast_standard_time_entries',
                'payroll_id_for_employee_id_column'
              )
            : sourceTag(null),
          location: normalized.location_display_name
            ? sourceTag('toast_standard_time_entries', 'location_name_on_time_entry')
            : fallbackLocationName
              ? sourceTag('vitals_location_fallback', 'time_entry_missing_location_name')
              : sourceTag(null),
        },
      });
    }

    const target = byCompositeSegment.get(compositeKey);
    target.regular_hours += normalized.regular_hours || 0;
    target.overtime_hours += normalized.overtime_hours || 0;
    target.regular_pay += normalized.regular_pay || 0;
    target.overtime_pay += normalized.overtime_pay || 0;
    target.total_pay += normalized.total_pay || 0;
    target.net_sales += normalized.net_sales || 0;
    target.declared_tips += normalized.declared_tips || 0;
    target.non_cash_tips += normalized.non_cash_tips || 0;
    target.tips_withheld += normalized.tips_withheld || 0;
    target.total_gratuity += normalized.total_gratuity || 0;

    if (normalized.hourly_rate !== null && normalized.hourly_rate !== undefined) {
      const weight = (normalized.regular_hours || 0) + (normalized.overtime_hours || 0) || 1;
      target.hourly_rate_weighted_sum += normalized.hourly_rate * weight;
      target.hourly_rate_weight += weight;
    }
  }

  return Array.from(byCompositeSegment.values()).map((row) => ({
    ...row,
    hourly_rate: row.hourly_rate_weight > 0 ? row.hourly_rate_weighted_sum / row.hourly_rate_weight : null,
    hourly_rate_weighted_sum: undefined,
    hourly_rate_weight: undefined,
  }));
}

function buildAnalyticsEmployeeTotalsIndex(normalizedLaborRows) {
  const byEmployeeKey = new Map();

  for (const row of normalizedLaborRows) {
    const employeeKeys = buildEmployeeLookupKeys(row);
    if (!employeeKeys.length) continue;

    for (const key of employeeKeys) {
      if (!byEmployeeKey.has(key)) {
        byEmployeeKey.set(key, {
          regular_hours: 0,
          overtime_hours: 0,
          regular_pay: 0,
          overtime_pay: 0,
          total_pay: 0,
          net_sales: 0,
          declared_tips: 0,
          non_cash_tips: 0,
          tips_withheld: 0,
          total_gratuity: 0,
        });
      }

      const target = byEmployeeKey.get(key);
      target.regular_hours += row.regular_hours || 0;
      target.overtime_hours += row.overtime_hours || 0;
      target.regular_pay += row.regular_pay || 0;
      target.overtime_pay += row.overtime_pay || 0;
      target.total_pay += row.total_pay || 0;
      target.net_sales += row.net_sales || 0;
      target.declared_tips += row.declared_tips || 0;
      target.non_cash_tips += row.non_cash_tips || 0;
      target.tips_withheld += row.tips_withheld || 0;
      target.total_gratuity += row.total_gratuity || 0;
    }
  }

  return byEmployeeKey;
}

function applyAnalyticsTotalsToTimeEntryRows(detailRows, analyticsTotalsByEmployeeKey) {
  const rows = Array.isArray(detailRows) ? detailRows : [];
  if (!(analyticsTotalsByEmployeeKey instanceof Map) || analyticsTotalsByEmployeeKey.size === 0) return rows;

  const byEmployee = new Map();

  for (const row of rows) {
    const employeeKeys = buildEmployeeLookupKeys(row);
    const employeeKey = employeeKeys.find((k) => analyticsTotalsByEmployeeKey.has(k)) || employeeKeys[0] || null;
    if (!employeeKey) continue;
    if (!byEmployee.has(employeeKey)) byEmployee.set(employeeKey, []);
    byEmployee.get(employeeKey).push(row);
  }

  const allocationFields = [
    'regular_hours',
    'overtime_hours',
    'regular_pay',
    'overtime_pay',
    'total_pay',
    'net_sales',
    'declared_tips',
    'non_cash_tips',
    'tips_withheld',
    'total_gratuity',
  ];

  for (const [employeeKey, employeeRows] of byEmployee.entries()) {
    const totals = analyticsTotalsByEmployeeKey.get(employeeKey);
    if (!totals || !employeeRows.length) continue;

    const weightTotal = employeeRows.reduce((sum, row) => sum + (row.regular_hours || 0) + (row.overtime_hours || 0), 0);
    const fallbackWeight = employeeRows.length > 0 ? 1 / employeeRows.length : 0;

    for (const row of employeeRows) {
      const rowHours = (row.regular_hours || 0) + (row.overtime_hours || 0);
      const weight = weightTotal > 0 ? rowHours / weightTotal : fallbackWeight;

      for (const field of allocationFields) {
        row[field] = (totals[field] || 0) * weight;
      }

      if (row.hourly_rate === null || row.hourly_rate === undefined) {
        const totalHours = (row.regular_hours || 0) + (row.overtime_hours || 0);
        if (totalHours > 0) row.hourly_rate = row.regular_pay / totalHours;
      }

      row.__analytics_allocation = {
        employee_key_used: employeeKey,
        allocation_method: 'employee_prorata_across_department_rows_by_hours',
      };
    }
  }

  return rows;
}

function joinLaborRowsToEmployees(laborRows, employeeByKey, timeEntryByKey = new Map()) {
  const timeEntryByEmployee = new Map();

  for (const [compositeKey, value] of timeEntryByKey.entries()) {
    const [employeeLookupKey] = String(compositeKey).split('|||');
    if (!timeEntryByEmployee.has(employeeLookupKey)) timeEntryByEmployee.set(employeeLookupKey, []);
    timeEntryByEmployee.get(employeeLookupKey).push(value);
  }

  return laborRows.flatMap((row) => {
    const lookupKeys = buildEmployeeLookupKeys(row);
    const matched = lookupKeys.map((k) => employeeByKey.get(k)).find(Boolean) || null;

    let candidateTimeEntries = [];
    for (const key of lookupKeys) {
      const entries = timeEntryByEmployee.get(key) || [];
      for (const entry of entries) candidateTimeEntries.push(entry);
    }

    if (!candidateTimeEntries.length) candidateTimeEntries = [null];

    const unique = new Map();
    for (const entry of candidateTimeEntries) {
      if (!entry) {
        if (!unique.has('__null__')) unique.set('__null__', null);
        continue;
      }
      const uniqKey = `${String(entry.job_code || '').toLowerCase()}|||${String(entry.job_name || '').toLowerCase()}|||${String(
        entry.location_code || entry.location_display_name || ''
      ).toLowerCase()}`;
      if (!unique.has(uniqKey)) unique.set(uniqKey, entry);
    }

    return Array.from(unique.values()).map((timeEntryMatch) => ({
      ...row,
      employee_id: matched?.employee_id || timeEntryMatch?.employee_id || row.external_employee_id || row.employee_id || null,
      employee_name: matched?.employee_name || timeEntryMatch?.employee_name || row.employee_name || null,
      toast_employee_id: matched?.toast_employee_id || timeEntryMatch?.toast_employee_id || row.toast_employee_id || null,
      export_employee_id: matched?.external_employee_id || timeEntryMatch?.external_employee_id || row.external_employee_id || null,
      department_name: row.job_name || timeEntryMatch?.job_name || null,
      department_code: row.job_code || timeEntryMatch?.job_code || null,
      location_display_name: row.location_display_name || timeEntryMatch?.location_display_name || row.location_name || null,
      location_code: row.location_code || timeEntryMatch?.location_code || null,
      __field_sources: {
        employee_name: matched?.employee_name
          ? sourceTag('toast_standard_employees', 'matched_by_employee_id_or_external_id')
          : timeEntryMatch?.employee_name
            ? sourceTag('toast_standard_time_entries', 'fallback_employee_name_from_time_entries')
            : row.employee_name
              ? sourceTag('toast_analytics_employee_grouped', 'employee_name_from_analytics')
              : sourceTag(null),
        department: row.job_name
          ? sourceTag('toast_analytics_employee_grouped', 'department_name_from_analytics')
          : timeEntryMatch?.job_name
            ? sourceTag('toast_standard_time_entries', 'fallback_department_from_time_entries')
            : timeEntryMatch?.job_code
              ? sourceTag('toast_standard_time_entries', 'fallback_department_code_from_time_entries')
              : sourceTag(null),
        hourly_rate: row.hourly_rate !== null
          ? sourceTag('toast_analytics_employee_grouped', 'hourly_rate_from_analytics')
          : sourceTag(null),
        employee_id: matched?.external_employee_id
          ? sourceTag('toast_standard_employees', 'payroll_id_from_employee_record')
          : timeEntryMatch?.external_employee_id
            ? sourceTag('toast_standard_time_entries', 'fallback_external_employee_id_from_time_entries')
            : row.external_employee_id
              ? sourceTag('toast_analytics_employee_grouped', 'external_employee_id_from_analytics')
              : sourceTag(null),
        location: row.location_display_name
          ? sourceTag('toast_analytics_employee_grouped', 'location_name_from_analytics')
          : timeEntryMatch?.location_display_name
            ? sourceTag('toast_standard_time_entries', 'fallback_location_from_time_entries')
            : sourceTag(null),
      },
    }));
  });
}

function buildPayrollExportRows(detailRows, fallbackLocationCode = null, { includeSourceAudit = false } = {}) {
  const byEmployeeDepartmentLocationRate = new Map();

  for (const row of detailRows) {
    const employeeName = String(row.employee_name || '').trim();
    const employeeId = String(row.export_employee_id || row.external_employee_id || '').trim();
    const toastEmployeeId = String(row.toast_employee_id || '').trim();

    const departmentName = String(row.department_name || row.job_name || '').trim();
    const departmentCode = String(row.department_code || row.job_code || '').trim();
    const locationName = row.location_display_name || row.location_name || '';
    const locationCode = row.location_code || fallbackLocationCode || '';
    const hourlyRate = row.hourly_rate;

    const employeeKey = normalizeGroupPart(employeeId, normalizeGroupPart(toastEmployeeId, '__unknown_employee__'));
    const departmentKey = normalizeGroupPart(departmentCode, normalizeGroupPart(departmentName, '__unassigned_department__'));
    const locationKey = normalizeGroupPart(locationCode, normalizeGroupPart(locationName, '__unknown_location__'));
    const rateKey =
      hourlyRate !== null && hourlyRate !== undefined ? String(Number(hourlyRate).toFixed(4)) : '';

    const key = [employeeKey, departmentKey, locationKey, rateKey].join('|||');

    if (!byEmployeeDepartmentLocationRate.has(key)) {
      byEmployeeDepartmentLocationRate.set(key, {
        Employee: employeeName || null,
        'Employee ID': employeeId || null,
        Department: departmentName || (departmentCode ? `Dept ${departmentCode}` : 'Unassigned'),
        'Job Code': departmentCode || null,
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
        Location: locationName || null,
        'Location Code': locationCode || null,
        __toast_employee_id: toastEmployeeId || null,
        __sourceCounters: {
          employee_name: new Map(),
          department: new Map(),
          hourly_rate: new Map(),
          employee_id: new Map(),
          location: new Map(),
        },
        __debug_rows: [],
      });
    }

    const agg = byEmployeeDepartmentLocationRate.get(key);

    if (!agg.Employee && employeeName) agg.Employee = employeeName;
    if (!agg['Employee ID'] && employeeId) agg['Employee ID'] = employeeId;
    if ((!agg.Department || agg.Department === 'Unassigned') && departmentName) agg.Department = departmentName;
    if (!agg['Job Code'] && departmentCode) agg['Job Code'] = departmentCode;
    if (!agg.Location && locationName) agg.Location = locationName;
    if (!agg['Location Code'] && locationCode) agg['Location Code'] = locationCode;
    if (!agg.__toast_employee_id && toastEmployeeId) agg.__toast_employee_id = toastEmployeeId;

    const rowSource = row.__field_sources || {};
    for (const field of ['employee_name', 'department', 'hourly_rate', 'employee_id', 'location']) {
      const src = rowSource[field]?.source || null;
      if (sourceIsPresent(src)) {
        const cur = agg.__sourceCounters[field].get(src) || 0;
        agg.__sourceCounters[field].set(src, cur + 1);
      }
    }

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

    agg.__debug_rows.push({
      employee_id: row.employee_id || null,
      export_employee_id: row.export_employee_id || null,
      toast_employee_id: row.toast_employee_id || null,
      department_code: row.department_code || row.job_code || null,
      department_name: row.department_name || row.job_name || null,
      location_display_name: row.location_display_name || null,
      analytics_allocation: row.__analytics_allocation || null,
    });
  }

  const result = Array.from(byEmployeeDepartmentLocationRate.values()).map((agg) => {
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
      'Employee ID': agg['Employee ID'],
      Department: agg.Department,
      'Job Code': agg['Job Code'],
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
      Location: agg.Location,
      'Location Code': agg['Location Code'],
      __toast_employee_id: agg.__toast_employee_id,
      __field_sources: {
        employee_name: sourceTag(pickDominantSource(agg.__sourceCounters.employee_name)),
        department: sourceTag(pickDominantSource(agg.__sourceCounters.department)),
        hourly_rate: sourceTag(pickDominantSource(agg.__sourceCounters.hourly_rate)),
        employee_id: sourceTag(pickDominantSource(agg.__sourceCounters.employee_id)),
        location: sourceTag(pickDominantSource(agg.__sourceCounters.location)),
      },
      __debug_rows: agg.__debug_rows,
    };
  });

  result.sort((a, b) => {
    const empId = String(a['Employee ID'] || '').localeCompare(String(b['Employee ID'] || ''));
    if (empId !== 0) return empId;
    const emp = String(a.Employee || '').localeCompare(String(b.Employee || ''));
    if (emp !== 0) return emp;
    const dept = String(a.Department || '').localeCompare(String(b.Department || ''));
    if (dept !== 0) return dept;
    const jobCode = String(a['Job Code'] || '').localeCompare(String(b['Job Code'] || ''));
    if (jobCode !== 0) return jobCode;
    const location = String(a.Location || '').localeCompare(String(b.Location || ''));
    if (location !== 0) return location;
    return String(a['Location Code'] || '').localeCompare(String(b['Location Code'] || ''));
  });

  const departmentAudit = [];
  const byEmployeeDepartment = new Map();

  for (const row of result) {
    const key = [
      normalizeGroupPart(row['Employee ID'], normalizeGroupPart(row.__toast_employee_id, '__unknown_employee__')),
      normalizeGroupPart(row['Job Code'], normalizeGroupPart(row.Department, '__unassigned_department__')),
    ].join('|||');

    if (!byEmployeeDepartment.has(key)) {
      byEmployeeDepartment.set(key, {
        Employee: row.Employee || null,
        'Employee ID': row['Employee ID'] || null,
        Department: row.Department || null,
        'Job Code': row['Job Code'] || null,
        'Regular Hours': 0,
        'Overtime Hours': 0,
      });
    }

    const agg = byEmployeeDepartment.get(key);
    agg['Regular Hours'] += row['Regular Hours'] || 0;
    agg['Overtime Hours'] += row['Overtime Hours'] || 0;
  }

  for (const v of byEmployeeDepartment.values()) {
    departmentAudit.push({
      Employee: v.Employee,
      'Employee ID': v['Employee ID'],
      Department: v.Department,
      'Job Code': v['Job Code'],
      'Regular Hours': Number(v['Regular Hours'].toFixed(2)),
      'Overtime Hours': Number(v['Overtime Hours'].toFixed(2)),
      'Total Hours': Number((v['Regular Hours'] + v['Overtime Hours']).toFixed(2)),
    });
  }

  const rows = result.map((row) => {
    const cleaned = { ...row };
    delete cleaned.__field_sources;
    delete cleaned.__toast_employee_id;
    delete cleaned.__debug_rows;
    return cleaned;
  });

  if (!includeSourceAudit) {
    return { rows, departmentAudit };
  }

  const rowSourceAudit = result.map((row, idx) => ({
    row_index: idx,
    employee: row.Employee || null,
    employee_id: row['Employee ID'] || null,
    toast_employee_id: row.__toast_employee_id || null,
    department: row.Department || null,
    job_code: row['Job Code'] || null,
    location: row.Location || null,
    location_code: row['Location Code'] || null,
    field_sources: {
      employee_name: row.__field_sources?.employee_name || sourceTag(null),
      department: row.__field_sources?.department || sourceTag(null),
      hourly_rate: row.__field_sources?.hourly_rate || sourceTag(null),
      employee_id: row.__field_sources?.employee_id || sourceTag(null),
      location: row.__field_sources?.location || sourceTag(null),
    },
  }));

  return {
    rows,
    departmentAudit,
    rowSourceAudit,
    rowBuildDebugSample: result.slice(0, 10).map((row, idx) => ({
      row_index: idx,
      employee: row.Employee || null,
      employee_id: row['Employee ID'] || null,
      toast_employee_id: row.__toast_employee_id || null,
      department: row.Department || null,
      job_code: row['Job Code'] || null,
      regular_hours: row['Regular Hours'],
      overtime_hours: row['Overtime Hours'],
    })),
  };
}

function detectReturnedRowGrain(rows) {
  const hasDeptSplit = rows.some((row) => {
    const title = safeTrim(row.Department);
    const code = safeTrim(row['Job Code']);
    return (title && title.toLowerCase() !== 'unassigned') || !!code;
  });

  const hasLocationSplit = rows.some((row) => {
    const name = safeTrim(row.Location);
    const code = safeTrim(row['Location Code']);
    return !!(name || code);
  });

  if (hasDeptSplit && hasLocationSplit) return 'one row per Employee + Department + Location for selected pay period';
  if (hasDeptSplit) return 'one row per Employee + Department (location approximated) for selected pay period';
  return 'one row per Employee (department/location not reliably returned by available payloads) for selected pay period';
}

function fieldSourceStatus({ inEmployees, inTimeEntries, inAnalytics, strategy }) {
  if (strategy === 'time_entries_primary_with_employee_enrichment') {
    if (inEmployees || inTimeEntries) return 'available_with_current_sources';
    return 'not_observed_in_current_sources';
  }
  if (inEmployees || inAnalytics) return 'available_with_current_sources';
  return 'not_observed_in_current_sources';
}

function buildCsvShapeAssessment({ strategy, employeesShape, timeEntriesShape, analyticsShape }) {
  const inEmployees = (k) => hasAnyField(employeesShape, k);
  const inTimeEntries = (k) => hasAnyField(timeEntriesShape, k);
  const inAnalytics = (k) => hasAnyField(analyticsShape, k);

  const fields = {
    employee_name: fieldSourceStatus({
      inEmployees: inEmployees('employee_name'),
      inTimeEntries: inTimeEntries('employee_name'),
      inAnalytics: inAnalytics('employee_name'),
      strategy,
    }),
    department: fieldSourceStatus({
      inEmployees: false,
      inTimeEntries: inTimeEntries('job_title_or_code'),
      inAnalytics: inAnalytics('job_title_or_code'),
      strategy,
    }),
    hourly_rate: fieldSourceStatus({
      inEmployees: false,
      inTimeEntries: inTimeEntries('pay_amounts'),
      inAnalytics: inAnalytics('pay_amounts'),
      strategy,
    }),
    regular_and_overtime_pay: fieldSourceStatus({
      inEmployees: false,
      inTimeEntries: inTimeEntries('pay_amounts'),
      inAnalytics: inAnalytics('pay_amounts'),
      strategy,
    }),
    employee_id_payroll_export_column: fieldSourceStatus({
      inEmployees: inEmployees('payroll_employee_id'),
      inTimeEntries: inTimeEntries('payroll_employee_id'),
      inAnalytics: inAnalytics('payroll_employee_id'),
      strategy,
    }),
    department_code: fieldSourceStatus({
      inEmployees: false,
      inTimeEntries: inTimeEntries('job_title_or_code'),
      inAnalytics: inAnalytics('job_title_or_code'),
      strategy,
    }),
    full_location_text: fieldSourceStatus({
      inEmployees: false,
      inTimeEntries: inTimeEntries('location_text_or_code'),
      inAnalytics: inAnalytics('location_text_or_code'),
      strategy,
    }),
  };

  const impossibleFields = Object.entries(fields)
    .filter(([, status]) => status !== 'available_with_current_sources')
    .map(([field]) => field);

  return {
    can_recreate_csv_shape_closely: impossibleFields.length === 0,
    selected_source_strategy: strategy,
    field_feasibility: fields,
    impossible_or_unobserved_fields: impossibleFields,
  };
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
    const keys = buildEmployeeLookupKeys(row);
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
    const rawAnalyticsRows = extractRows(analytics.data);

    const fallbackLocationCode = vitalsRecord['Toast Location ID'] ? String(vitalsRecord['Toast Location ID']) : null;

    const timeEntryByKey = buildTimeEntryIdentityIndex(timeEntryRows, location, fallbackLocationCode);

    const normalizedLaborRows = rawAnalyticsRows.map((row) =>
      normalizeAnalyticsLaborRow(row, {
        location,
        periodStart: start,
        periodEnd: end,
        fallbackLocationCode,
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
      naturalGrainHint: 'one row per time entry / punch segment (employee + department + location when populated)',
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
      naturalGrainHint: 'employee grouped summary rows (ERA groupBy EMPLOYEE)',
    });

    const canTimeEntriesShapeRows =
      hasAnyField(timeEntriesShape, 'job_title_or_code') && hasAnyField(timeEntriesShape, 'location_text_or_code');

    const strategy = canTimeEntriesShapeRows
      ? 'time_entries_primary_with_employee_enrichment'
      : 'analytics_primary_fallback';

    const sourceDetailRows =
      strategy === 'time_entries_primary_with_employee_enrichment'
        ? applyAnalyticsTotalsToTimeEntryRows(
            buildExportShapedRowsFromTimeEntries({
              timeEntryRows,
              employeeByKey,
              fallbackLocationName: location,
              fallbackLocationCode,
              periodStart: start,
              periodEnd: end,
            }),
            buildAnalyticsEmployeeTotalsIndex(normalizedLaborRows)
          )
        : joinLaborRowsToEmployees(normalizedLaborRows, employeeByKey, timeEntryByKey);

    const csvShapeAssessment = buildCsvShapeAssessment({
      strategy,
      employeesShape,
      timeEntriesShape,
      analyticsShape,
    });

    const rowBuild = buildPayrollExportRows(sourceDetailRows, fallbackLocationCode, {
      includeSourceAudit: includeDebug,
    });

    const rows = rowBuild.rows;
    const departmentAudit = rowBuild.departmentAudit || [];
    const rowSourceAudit = includeDebug ? rowBuild.rowSourceAudit : null;
    const rowBuildDebugSample = includeDebug ? rowBuild.rowBuildDebugSample : null;
    const rowGrain = detectReturnedRowGrain(rows);

    const columns = [
      'Employee',
      'Employee ID',
      'Department',
      'Job Code',
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
              ? 'Standard time entries expose department/location fields, so row grain is built from time entries and employee names/IDs are enriched from Standard employees.'
              : 'Time entries do not expose sufficient department/location fields in sampled payload; fallback uses analytics employee-grouped rows.',
          row_field_source_audit: rowSourceAudit,
          row_build_debug_sample: rowBuildDebugSample,
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
            : 'Toast Standard employees joined to Toast Analytics labor rows and aggregated to payroll-export-like rows',
        source_row_grain_before_transform:
          strategy === 'time_entries_primary_with_employee_enrichment'
            ? 'one row per Toast Standard time entry for selected period'
            : 'one row per Toast ERA labor row grouped by EMPLOYEE for selected period',
        employee_identity_source: 'Toast employee GUID internally; Payroll Employee ID shown when available',
        labor_totals_source:
          strategy === 'time_entries_primary_with_employee_enrichment'
            ? 'Toast Analytics ERA labor report allocated onto Standard time-entry employee rows'
            : 'Toast Analytics ERA labor report (groupBy: EMPLOYEE) for selected pay period',
        employee_column_mapping:
          'Employee column prefers Toast Standard employee full name; falls back to analytics name.',
        employee_id_column_mapping:
          'Employee ID column prefers payrollEmployeeId/payrollId/payrollEmployeeNumber/employeeNumber/employeeCode/externalEmployeeId from Toast Standard employees; remains blank when unavailable.',
        join_key_between_sources:
          'Toast GUID is used as stable backend employee identity; payroll employee ID is used for visible output when available.',
        grouping_key_after_transform:
          'lower(payroll employee id when present, else toast_employee_id), lower(department code OR department name), lower(location_code OR location_name), lower(rate when present)',
        row_grain_target: 'one row per Employee + Department + Location, with optional rate separation',
        row_grain_returned: rowGrain,
        csv_shape_recreation_assessment: csvShapeAssessment,
        exact_payroll_export_endpoint_available: false,
        note:
          strategy === 'time_entries_primary_with_employee_enrichment'
            ? 'Direct Toast Payroll Export endpoint is not configured in this codebase; rows are shaped from Standard time entries, enriched with employees, and then payroll-facing columns are returned.'
            : 'Direct Toast Payroll Export endpoint is not configured in this codebase; data is reconstructed from employees + Analytics labor rows.',
        approximation_notes:
          strategy === 'time_entries_primary_with_employee_enrichment'
            ? [
                'Time entries are used for row grain when department/location fields exist in the payload.',
                'Analytics totals are allocated back across each employee’s department rows by hours.',
                'Visible output intentionally omits Toast GUID column even though GUID remains in backend/debug.',
              ]
            : [
                'Analytics rows are employee-grained and may require enrichment/fallback for department/location.',
                'Visible output intentionally omits Toast GUID column even though GUID remains in backend/debug.',
              ],
      },
      row_count: rows.length,
      columns,
      rows,
      department_audit: departmentAudit,
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
    normalizeTimeEntryRow,
    buildAnalyticsEmployeeTotalsIndex,
    applyAnalyticsTotalsToTimeEntryRows,
    buildExportShapedRowsFromTimeEntries,
    joinLaborRowsToEmployees,
    buildPayrollExportRows,
    buildTimeEntryIdentityIndex,
    buildEmployeeJobCompositeLookupKeys,
  },
};
