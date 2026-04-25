// server/src/domain/toastOriginalPayPeriodService.js
//
// Fetches Toast pay period rows for staff audit view, shaped to resemble
// Toast Payroll Export CSV output as closely as possible from available APIs.

const { fetchVitalsSnapshot } = require('../providers/vitalsProvider');
const {
  fetchToastEmployeesFromVitals,
  fetchToastJobsFromVitals,
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

function normalizeHourlyRateKey(value) {
  const n = toNum(value);
  if (n === null) return '__missing_rate__';
  return n.toFixed(2);
}

function looksLikeUuid(value) {
  const s = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function round2(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function formatLastFirst(firstName, lastName) {
  const first = safeTrim(firstName) || '';
  const last = safeTrim(lastName) || '';
  if (last && first) return `${last}, ${first}`;
  return last || first || '';
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
    const toastEmployeeGroupingKey = toastEmployeeId ? String(toastEmployeeId).toLowerCase() : '__missing_toast_employee_guid__';
    const jobKey = normalizeGroupPart(normalized.job_code, normalizeGroupPart(normalized.job_name, '__missing_job_department__'));
    const rateKey = normalizeHourlyRateKey(normalized.hourly_rate);
    const compositeKey = [toastEmployeeGroupingKey, jobKey, rateKey].join('|||');

    if (!byCompositeSegment.has(compositeKey)) {
      byCompositeSegment.set(compositeKey, {
        location_name: fallbackLocationName,
        location_code: normalized.location_code || fallbackLocationCode || null,
        location_display_name: normalized.location_display_name || fallbackLocationName || null,
        business_date: normalized.business_date,
        pay_type: normalized.pay_type,
        pay_period_start: periodStart,
        pay_period_end: periodEnd,
        employee_id: employeeMatch?.employee_id || normalized.employee_id || null,
        external_employee_id: exportEmployeeId,
        employee_name: employeeMatch?.employee_name || normalized.employee_name || (toastEmployeeId ? null : 'Missing Employee Name'),
        toast_employee_id: toastEmployeeId,
        export_employee_id: exportEmployeeId,
        job_code: normalized.job_code || null,
        job_name: normalized.job_name || null,
        department_job_display:
          normalized.job_code || normalized.job_name
            ? normalized.job_code && normalized.job_name
              ? `${normalized.job_code} - ${normalized.job_name}`
              : normalized.job_code || normalized.job_name
            : 'Missing job/department',
        regular_hours: 0,
        overtime_hours: 0,
        hourly_rate: normalized.hourly_rate,
        __field_sources: {
          employee_name: employeeMatch?.employee_name
            ? sourceTag('toast_standard_employees', 'matched_by_employee_id_or_external_id')
            : normalized.employee_name
              ? sourceTag('toast_standard_time_entries', 'employee_name_present_on_time_entry')
              : sourceTag(null),
          job_title: normalized.job_name
            ? sourceTag('toast_standard_time_entries', 'job_name_present_on_time_entry')
            : normalized.job_code
              ? sourceTag('toast_standard_time_entries', 'job_code_present_on_time_entry')
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
          location: sourceTag(null),
        },
      });
    }

    const target = byCompositeSegment.get(compositeKey);
    target.regular_hours += normalized.regular_hours || 0;
    target.overtime_hours += normalized.overtime_hours || 0;
  }

  return Array.from(byCompositeSegment.values());
}

function buildEmployeeAnalyticsTotalsIndex(normalizedLaborRows) {
  const byKey = new Map();

  for (const row of normalizedLaborRows) {
    const keys = buildEmployeeJobCompositeLookupKeys(row);
    if (!keys.length) continue;

    for (const key of keys) {
      if (!byKey.has(key)) {
        byKey.set(key, {
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

      const target = byKey.get(key);
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

  return byKey;
}

function applyAnalyticsTotalsToTimeEntryRows(detailRows, analyticsTotalsByKey) {
  const rows = Array.isArray(detailRows) ? detailRows : [];
  if (!(analyticsTotalsByKey instanceof Map) || analyticsTotalsByKey.size === 0) return rows;

  const byComposite = new Map();
  for (const row of rows) {
    const keys = buildEmployeeJobCompositeLookupKeys(row);
    const key = keys.find((k) => analyticsTotalsByKey.has(k)) || keys[0] || null;
    if (!key) continue;
    if (!byComposite.has(key)) byComposite.set(key, []);
    byComposite.get(key).push(row);
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

  for (const [key, employeeJobRows] of byComposite.entries()) {
    const totals = analyticsTotalsByKey.get(key);
    if (!totals || !employeeJobRows.length) continue;

    const weightTotal = employeeJobRows.reduce((sum, row) => sum + (row.regular_hours || 0) + (row.overtime_hours || 0), 0);
    const fallbackWeight = employeeJobRows.length > 0 ? 1 / employeeJobRows.length : 0;

    for (const row of employeeJobRows) {
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
        composite_key_used: key,
        allocation_method: 'employee_job_composite_prorata_by_hours',
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

    const rowCompositeKeys = buildEmployeeJobCompositeLookupKeys(row);
    const exactTimeEntryMatch = rowCompositeKeys.map((k) => timeEntryByKey.get(k)).find(Boolean) || null;

    let candidateTimeEntries = [];
    if (exactTimeEntryMatch) {
      candidateTimeEntries = [exactTimeEntryMatch];
    } else if (!normalizeJobIdentityPart(row)) {
      const aggregated = [];
      for (const key of lookupKeys) {
        const entries = timeEntryByEmployee.get(key) || [];
        for (const entry of entries) aggregated.push(entry);
      }

      const unique = new Map();
      for (const entry of aggregated) {
        const uniqKey = `${String(entry.job_code || '').toLowerCase()}|||${String(entry.job_name || '').toLowerCase()}`;
        if (!unique.has(uniqKey)) unique.set(uniqKey, entry);
      }
      candidateTimeEntries = Array.from(unique.values());
    }

    if (!candidateTimeEntries.length) candidateTimeEntries = [null];

    return candidateTimeEntries.map((timeEntryMatch) => ({
      ...row,
      employee_id: matched?.employee_id || timeEntryMatch?.employee_id || row.external_employee_id || row.employee_id || null,
      employee_name: matched?.employee_name || timeEntryMatch?.employee_name || row.employee_name || null,
      toast_employee_id: matched?.toast_employee_id || timeEntryMatch?.toast_employee_id || row.toast_employee_id || null,
      export_employee_id: matched?.external_employee_id || timeEntryMatch?.external_employee_id || row.external_employee_id || null,
      job_name: row.job_name || timeEntryMatch?.job_name || null,
      job_code: row.job_code || timeEntryMatch?.job_code || null,
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
        job_title: row.job_name
          ? sourceTag('toast_analytics_employee_grouped', 'job_name_from_analytics')
          : timeEntryMatch?.job_name
            ? sourceTag('toast_standard_time_entries', 'fallback_job_from_time_entries')
            : timeEntryMatch?.job_code
              ? sourceTag('toast_standard_time_entries', 'fallback_job_code_from_time_entries')
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
  const byEmployeeJob = new Map();

  for (const row of detailRows) {
    const employeeName = String(row.employee_name || '').trim();
    const toastEmployeeId = String(row.toast_employee_id || '').trim();
    const exportEmployeeId = String(row.export_employee_id || '').trim();
    const departmentJob =
      row.department_job_display ||
      (row.job_code && row.job_name ? `${row.job_code} - ${row.job_name}` : row.job_code || row.job_name || 'Missing job/department');

    const normalizedRateKey = normalizeHourlyRateKey(row.hourly_rate);
    const normalizedRateNum = toNum(row.hourly_rate);

    const employeeKey = toastEmployeeId ? normalizeGroupPart(toastEmployeeId) : '__missing_toast_employee_guid__';
    const jobKey = normalizeGroupPart(departmentJob, '__missing_job_department__');
    const key = [employeeKey, jobKey, normalizedRateKey].join('|||');

    if (!byEmployeeJob.has(key)) {
      byEmployeeJob.set(key, {
        __toast_employee_guid: toastEmployeeId || '__missing_toast_employee_guid__',
        Employee: employeeName || 'Missing Employee Name',
        'Department / Job': departmentJob,
        'Regular Hours': 0,
        'Overtime Hours': 0,
        RateRaw: normalizedRateNum,
        'Employee ID': exportEmployeeId || 'Missing Employee ID',
        __sourceCounters: {
          employee_name: new Map(),
          job_title: new Map(),
          hourly_rate: new Map(),
          employee_id: new Map(),
          location: new Map(),
        },
        __debug_rows: [],
      });
    }

    const agg = byEmployeeJob.get(key);

    if ((!agg.Employee || agg.Employee === 'Missing Employee Name') && employeeName) agg.Employee = employeeName;
    if ((!agg['Employee ID'] || agg['Employee ID'] === 'Missing Employee ID') && exportEmployeeId) agg['Employee ID'] = exportEmployeeId;

    const rowSource = row.__field_sources || {};
    for (const field of ['employee_name', 'job_title', 'hourly_rate', 'employee_id', 'location']) {
      const src = rowSource[field]?.source || null;
      if (sourceIsPresent(src)) {
        const cur = agg.__sourceCounters[field].get(src) || 0;
        agg.__sourceCounters[field].set(src, cur + 1);
      }
    }

    agg['Regular Hours'] += row.regular_hours || 0;
    agg['Overtime Hours'] += row.overtime_hours || 0;

    agg.__debug_rows.push({
      employee_id: row.employee_id || null,
      export_employee_id: row.export_employee_id || null,
      toast_employee_id: row.toast_employee_id || null,
      job_code: row.job_code || null,
      job_name: row.job_name || null,
      location_display_name: row.location_display_name || null,
      analytics_allocation: row.__analytics_allocation || null,
    });
  }

  const result = Array.from(byEmployeeJob.values()).map((agg) => {
    const totalHours = (agg['Regular Hours'] || 0) + (agg['Overtime Hours'] || 0);

    return {
      Employee: agg.Employee,
      'Employee ID': agg['Employee ID'],
      'Department / Job': agg['Department / Job'],
      Rate: agg.RateRaw !== null ? Number(agg.RateRaw.toFixed(2)) : null,
      'Regular Hours': Number((agg['Regular Hours'] || 0).toFixed(2)),
      'Overtime Hours': Number((agg['Overtime Hours'] || 0).toFixed(2)),
      'Total Hours': Number(totalHours.toFixed(2)),
      __field_sources: {
        employee_name: sourceTag(pickDominantSource(agg.__sourceCounters.employee_name)),
        job_title: sourceTag(pickDominantSource(agg.__sourceCounters.job_title)),
        hourly_rate: sourceTag(pickDominantSource(agg.__sourceCounters.hourly_rate)),
        employee_id: sourceTag(pickDominantSource(agg.__sourceCounters.employee_id)),
        location: sourceTag(pickDominantSource(agg.__sourceCounters.location)),
      },
      __debug_rows: agg.__debug_rows,
      __toast_employee_guid: agg.__toast_employee_guid,
    };
  });

  result.sort((a, b) => {
    const empId = String(a['Employee ID'] || '').localeCompare(String(b['Employee ID'] || ''));
    if (empId !== 0) return empId;
    const emp = String(a.Employee || '').localeCompare(String(b.Employee || ''));
    if (emp !== 0) return emp;
    return String(a['Department / Job'] || '').localeCompare(String(b['Department / Job'] || ''));
  });

  const rows = result.map((row) => {
    const cleaned = { ...row };
    delete cleaned.__toast_employee_guid;
    delete cleaned.__field_sources;
    delete cleaned.__debug_rows;
    return cleaned;
  });

  if (!includeSourceAudit) return rows;

  const rowBuildDebugSample = result.slice(0, 10).map((row, idx) => ({
    row_index: idx,
    comparison_key_used: `${String(row.__toast_employee_guid || '').toLowerCase()}|||${String(
      row['Department / Job'] || ''
    ).toLowerCase()}|||${String(row.Rate || '__missing_rate__').toLowerCase()}`,
    guid_used: row.__toast_employee_guid || null,
    payroll_employee_id_used: row['Employee ID'] || null,
    employee_name: row.Employee || null,
    employee_name_source: row.__field_sources?.employee_name?.source || null,
    job_title: row['Department / Job'] || null,
    job_code: null,
    job_title_source: row.__field_sources?.job_title?.source || null,
    hourly_rate: row.Rate,
    hourly_rate_source: row.__field_sources?.hourly_rate?.source || null,
    location: null,
    location_source: null,
    analytics_allocation_sample: row.__debug_rows?.[0]?.analytics_allocation || null,
  }));

  const rowSourceAudit = result.map((row, idx) => ({
    row_index: idx,
    employee: row.Employee || null,
    toast_employee_id: row.__toast_employee_guid || null,
    employee_id: row['Employee ID'] || null,
    job_title: row['Department / Job'] || null,
    job_code: null,
    rate: row.Rate,
    location: null,
    location_code: null,
    field_sources: {
      employee_name: row.__field_sources?.employee_name || sourceTag(null),
      job_title: row.__field_sources?.job_title || sourceTag(null),
      hourly_rate: row.__field_sources?.hourly_rate || sourceTag(null),
      employee_id: row.__field_sources?.employee_id || sourceTag(null),
      location: row.__field_sources?.location || sourceTag(null),
    },
    contributing_detail_rows: row.__debug_rows || [],
  }));

  return { rows, rowSourceAudit, rowBuildDebugSample };
}

function buildToastOriginalHoursRows({ timeEntryRows, employeeRows, jobRows, includeDebug = false }) {
  const timeAgg = new Map();
  let skippedMissingEmployeeOrJobKey = 0;

  for (const te of Array.isArray(timeEntryRows) ? timeEntryRows : []) {
    const emp =
      safeTrim(te?.employeeGuid) ||
      safeTrim(te?.employeeId) ||
      safeTrim(te?.employeeReference?.guid) ||
      '';

    const jobGuid = safeTrim(te?.jobReference?.guid) || safeTrim(te?.jobGuid) || '';
    const jobKey = jobGuid;

    if (!emp || !jobKey) {
      skippedMissingEmployeeOrJobKey += 1;
      continue;
    }

    const rate = te?.wageRate ?? te?.hourlyWage ?? te?.hourlyRate ?? te?.rate ?? te?.payRate;
    const key = `${emp}|${jobKey}|${rate ?? ''}`;
    const reg = Number(te?.regularHours ?? te?.hoursRegular ?? te?.regHours ?? 0) || 0;
    const ot = Number(te?.overtimeHours ?? te?.hoursOvertime ?? te?.otHours ?? 0) || 0;

    if (!timeAgg.has(key)) {
      timeAgg.set(key, {
        reg: 0,
        ot: 0,
        jobGuid: jobGuid || '',
      });
    }

    const agg = timeAgg.get(key);
    agg.reg += reg;
    agg.ot += ot;
    if (!agg.jobGuid && jobGuid) agg.jobGuid = jobGuid;
  }

  const empDim = {};
  for (const e of Array.isArray(employeeRows) ? employeeRows : []) {
    const chosenName = safeTrim(e?.chosenName);
    const computedName = chosenName || fullNameFromParts(e?.firstName, e?.lastName);
    const obj = {
      displayName: computedName || '',
      externalId: safeTrim(e?.externalEmployeeId) || safeTrim(e?.externalId) || '',
      deleted: !!e?.deleted,
    };
    if (e?.guid) empDim[e.guid] = obj;
    if (e?.v2EmployeeGuid) empDim[e.v2EmployeeGuid] = obj;
  }

  const jobsByGuid = {};
  for (const r of Array.isArray(jobRows) ? jobRows : []) {
    const g = String(r?.guid || '').trim();
    if (!g) continue;
    jobsByGuid[g] = {
      jobCode: safeTrim(r?.code) || '',
      jobTitle: safeTrim(r?.title) || '',
      defaultWage: toNum(r?.defaultWage),
      deleted: !!r?.deleted,
      wageFrequency: safeTrim(r?.wageFrequency),
    };
  }

  let missingEmployeeNameCount = 0;
  let missingEmployeeIdCount = 0;
  let missingJobTitleCount = 0;
  let missingJobCodeCount = 0;

  const rows = [];
  for (const [key, v] of timeAgg.entries()) {
    const [empGuid, jobGuid, rateStr] = key.split('|');
    const emp = empDim[empGuid] || {};
    const jobMeta = (jobGuid && jobsByGuid[jobGuid]) || {};

    const employeeName = safeTrim(emp.displayName) || 'Missing Employee Name';
    const employeeId = safeTrim(emp.externalId) || 'Missing Employee ID';
    const jobCode = safeTrim(jobMeta.jobCode) || 'Missing job code';
    const jobTitle = safeTrim(jobMeta.jobTitle) || 'Missing job title';

    rows.push({
      Employee: employeeName,
      'Employee ID': employeeId,
      'Job Code': jobCode || 'Missing job code',
      'Job Title': jobTitle || 'Missing job title',
      'Hourly Rate': toNum(rateStr),
      'Regular Hours': round2(v?.reg),
      'Overtime Hours': round2(v?.ot),
      employee_name: employeeName,
      employee_id: employeeId,
      job_name: jobTitle,
      job_code: jobCode,
      hourly_rate: toNum(rateStr),
      regular_hours: round2(v?.reg),
      overtime_hours: round2(v?.ot),
      __field_sources: {
        employee_name: sourceTag('toast_standard_employees'),
        employee_id: sourceTag('toast_standard_employees.externalEmployeeId'),
        job_title: sourceTag('toast_standard_jobs.title'),
        job_code: sourceTag('toast_standard_jobs.code'),
        hourly_rate: sourceTag('toast_standard_time_entries.hourlyWage'),
        hours: sourceTag('toast_standard_time_entries'),
      },
    });

    if (employeeName === 'Missing Employee Name') missingEmployeeNameCount += 1;
    if (employeeId === 'Missing Employee ID') missingEmployeeIdCount += 1;
    if (jobTitle === 'Missing job title') missingJobTitleCount += 1;
    if (jobCode === 'Missing job code') missingJobCodeCount += 1;
  }

  rows.sort((a, b) => {
    const employeeCmp = String(a.Employee || '').localeCompare(String(b.Employee || ''));
    if (employeeCmp !== 0) return employeeCmp;
    const jobCodeCmp = String(a['Job Code'] || '').localeCompare(String(b['Job Code'] || ''));
    if (jobCodeCmp !== 0) return jobCodeCmp;
    return String(a['Hourly Rate'] || '').localeCompare(String(b['Hourly Rate'] || ''));
  });

  if (!includeDebug) return { rows, debug: null };

  return {
    rows,
    debug: {
      raw_time_entries_count: Array.isArray(timeEntryRows) ? timeEntryRows.length : 0,
      time_agg_group_count: timeAgg.size,
      employee_map_count: Object.keys(empDim).length,
      standard_job_rows_count: Array.isArray(jobRows) ? jobRows.length : 0,
      skipped_time_entries_missing_employee_or_job_key: skippedMissingEmployeeOrJobKey,
      missingEmployeeNameCount,
      missingEmployeeIdCount,
      missingJobTitleCount,
      missingJobCodeCount,
    },
  };
}

function detectReturnedRowGrain(rows) {
  const hasDepartmentSplit = rows.some((row) => {
    const departmentJob = safeTrim(row['Department / Job']);
    return !!departmentJob && departmentJob.toLowerCase() !== 'missing job/department';
  });

  if (hasDepartmentSplit) return 'one row per Employee + Department/Job + Rate for selected pay period';
  return 'one row per Employee + Rate (department/job missing on source time entries) for selected pay period';
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
    job_title: fieldSourceStatus({
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
    job_code: fieldSourceStatus({
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
        analytics_job_keys: buildEmployeeJobCompositeLookupKeys(row),
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

    const [employees, jobs, timeEntries] = await Promise.all([
      fetchToastEmployeesFromVitals({ vitalsRecord, locationName: location }),
      fetchToastJobsFromVitals({ vitalsRecord, locationName: location }),
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

    if (!jobs.ok) {
      throw new Error(`toast_jobs_failed:${jobs.error || 'unknown'}:${formatAnalyticsError(jobs)}`);
    }

    const employeeRows = extractRows(employees.data);
    const timeEntryRows = timeEntries && timeEntries.ok ? extractRows(timeEntries.data) : [];
    const jobRows = extractRows(jobs.data);

    const rowBuild = buildToastOriginalHoursRows({
      timeEntryRows,
      employeeRows,
      jobRows,
      includeDebug,
    });

    const rows = rowBuild.rows;
    const columns = ['Employee', 'Employee ID', 'Job Title', 'Job Code', 'Hourly Rate', 'Regular Hours', 'Overtime Hours'];
    const rowDebugCounts = rowBuild?.debug || {};
    const metadata = {
      standardTimeEntryCount: timeEntryRows.length,
      standardEmployeeCount: employeeRows.length,
      standardJobCount: jobRows.length,
      shapedRowCount: rows.length,
      missingEmployeeNameCount: rowDebugCounts.missingEmployeeNameCount || 0,
      missingEmployeeIdCount: rowDebugCounts.missingEmployeeIdCount || 0,
      missingJobTitleCount: rowDebugCounts.missingJobTitleCount || 0,
      missingJobCodeCount: rowDebugCounts.missingJobCodeCount || 0,
      source: 'toast_standard_only',
    };

    const debug = includeDebug
      ? {
          row_builder_counts: rowBuild.debug,
        }
      : null;

    return {
      location_name: location,
      period_start: start,
      period_end: end,
      source: {
        provider: 'toast',
        api_mode: 'toast_original_hours_time_entries_grouped',
        label: 'Toast Standard time entries grouped by employee GUID + job GUID + rate with employee/job metadata lookups',
        source_row_grain_before_transform: 'one row per Toast Standard time entry for selected period',
        employee_identity_source: 'Toast Standard labor/hr employees endpoint',
        labor_totals_source: 'Toast Standard time entries only (regular/overtime hours)',
        employee_column_mapping: 'Employee and Employee ID are display-only fields from Standard employees keyed by guid/v2EmployeeGuid',
        join_key_between_sources: 'employeeReference.guid -> employees.guid and jobReference.guid -> jobs.guid',
        grouping_key_after_transform: 'Rows are grouped by employee GUID + job GUID + hourlyWage.',
        row_grain_target: 'one row per Employee + Job Code + Hourly Rate for selected pay period',
        row_grain_returned: 'one row per Employee + Job Code + Hourly Rate for selected pay period',
        csv_shape_recreation_assessment: null,
        exact_payroll_export_endpoint_available: false,
        note:
          'This table uses Toast Standard only: time entries provide hours/rate and employee/job dimensions are joined from Standard employees/jobs.',
        approximation_notes: [
          'Time entries missing employee key or job key are skipped and counted in debug.',
          'Missing display metadata is emitted as explicit Missing* placeholder text in output columns.',
        ],
      },
      metadata,
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
    normalizeTimeEntryRow,
    buildEmployeeAnalyticsTotalsIndex,
    applyAnalyticsTotalsToTimeEntryRows,
    buildExportShapedRowsFromTimeEntries,
    joinLaborRowsToEmployees,
    buildPayrollExportRows,
    buildTimeEntryIdentityIndex,
    buildEmployeeJobCompositeLookupKeys,
    buildToastOriginalHoursRows,
  },
};
