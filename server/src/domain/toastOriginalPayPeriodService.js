// server/src/domain/toastOriginalPayPeriodService.js
//
// Fetches Toast pay period rows for staff audit view, shaped to resemble
// Toast Payroll Export CSV output as closely as possible from available APIs.

const { fetchVitalsSnapshot } = require('../providers/vitalsProvider');
const { fetchToastAnalyticsJobsFromVitals, fetchToastEmployeesFromVitals, fetchToastJobsFromVitals } = require('../providers/toastProvider');
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

function buildEmployeeName(row) {
  const hasChosen = safeTrim(row?.chosenName);
  const chosenLast = hasChosen ? fullNameFromParts(row?.chosenName, row?.lastName) : null;
  if (chosenLast) return chosenLast;
  const firstLast = fullNameFromParts(row?.firstName, row?.lastName);
  if (firstLast) return firstLast;
  return safeTrim(
    pick(row, ['fullName', 'displayName', 'name', 'employeeName', 'employee_name', 'lastNameFirstName'])
  );
}

function extractWageOverrides(row) {
  const source = Array.isArray(row?.wageOverrides) ? row.wageOverrides : [];
  return source
    .map((entry) => ({
      job_guid: safeTrim(pick(entry, ['jobReference.guid', 'jobReference.id', 'jobGuid', 'job_guid'])),
      wage: toNum(pick(entry, ['wage', 'hourlyRate', 'payRate'])),
    }))
    .filter((entry) => entry.job_guid && entry.wage !== null);
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

  const employeeName = buildEmployeeName(row);
  const wageOverrides = extractWageOverrides(row);
  const wageByJobGuid = new Map(wageOverrides.map((x) => [String(x.job_guid).toLowerCase(), x.wage]));

  return {
    employee_id: toastEmployeeId,
    external_employee_id: payrollEmployeeId,
    employee_name: employeeName,
    wage_overrides: wageOverrides,
    wage_by_job_guid: wageByJobGuid,
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

  const jobGuid =
    safeTrim(
      pick(row, [
        'jobGuid',
        'job_guid',
        'departmentGuid',
        'department_guid',
        'job.id',
        'job.guid',
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
    job_guid: jobGuid,
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

function lookupKeysForRow(row) {
  return [row?.employee_id, row?.external_employee_id]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase());
}

function buildJoinDiagnostics({ employeeRows, employeeByKey, jobRows, rawAnalyticsRows, normalizedLaborRows }) {
  const normalizedEmployeeRows = sampleRows(employeeRows, 25).map((row) => normalizeEmployeeIdentity(row));
  const normalizedJobRows = sampleRows(jobRows, 25).map((row) => normalizeJobIdentity(row));
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
    sample_raw_employee_row_0_full: employeeRows[0] || null,
    sample_raw_employee_row_1_full: employeeRows[1] || null,
    sample_raw_job_rows: sampleRows(jobRows, 5),
    sample_raw_job_row_0_full: jobRows[0] || null,
    sample_raw_analytics_rows: sampleRows(rawAnalyticsRows, 5),
    sample_normalized_employee_identity: normalizedEmployeeRows.slice(0, 10),
    sample_normalized_employee_identity_0: normalizedEmployeeRows[0] || null,
    sample_normalized_job_identity: normalizedJobRows.slice(0, 10),
    sample_normalized_job_identity_0: normalizedJobRows[0] || null,
    sample_normalized_analytics_labor: normalizedAnalyticsRows.slice(0, 10),
    employee_index_key_sample: Array.from(employeeByKey.keys()).slice(0, 30),
    analytics_join_key_sample: joinKeySamples,
    join_summary: joinedStats,
    unmatched_analytics_rows_sample: unmatchedSamples,
  };
}

function normalizeJobIdentity(row) {
  return {
    job_guid: safeTrim(pick(row, ['guid', 'id', 'jobGuid', 'job_guid', 'referenceGuid', 'jobReference.guid'])),
    job_code: safeTrim(pick(row, ['code', 'jobCode', 'job_code', 'externalId', 'external_id'])),
    job_name: safeTrim(pick(row, ['name', 'jobName', 'job_name', 'title', 'displayName', 'departmentName'])),
  };
}

function buildJobIndex(jobRows) {
  const byKey = new Map();
  for (const row of jobRows) {
    const job = normalizeJobIdentity(row);
    const keys = [job.job_guid, job.job_code].filter(Boolean).map((x) => String(x).toLowerCase());
    for (const key of keys) {
      if (!byKey.has(key)) byKey.set(key, job);
    }
  }
  return byKey;
}

function joinLaborRowsToEmployees(laborRows, employeeByKey, jobByKey = new Map()) {
  return laborRows.map((row) => {
    const lookupKeys = [row.employee_id, row.external_employee_id]
      .filter(Boolean)
      .map((x) => String(x).toLowerCase());
    const matched = lookupKeys.map((k) => employeeByKey.get(k)).find(Boolean) || null;
    const jobLookupKeys = [row.job_guid, row.job_code].filter(Boolean).map((x) => String(x).toLowerCase());
    const matchedJob = jobLookupKeys.map((k) => jobByKey.get(k)).find(Boolean) || null;
    const matchedWageByJob =
      row.job_guid && matched?.wage_by_job_guid
        ? matched.wage_by_job_guid.get(String(row.job_guid).toLowerCase()) ?? null
        : null;
    const matchedSingleWage =
      matchedWageByJob === null && Array.isArray(matched?.wage_overrides) && matched.wage_overrides.length === 1
        ? matched.wage_overrides[0].wage
        : null;
    return {
      ...row,
      employee_id: matched?.employee_id || row.employee_id || null,
      employee_name: matched?.employee_name || row.employee_name || null,
      toast_employee_id: matched?.employee_id || row.employee_id || null,
      export_employee_id: matched?.external_employee_id || row.external_employee_id || null,
      job_code: row.job_code || matchedJob?.job_code || null,
      job_name: row.job_name || matchedJob?.job_name || null,
      hourly_rate:
        row.hourly_rate !== null && row.hourly_rate !== undefined
          ? row.hourly_rate
          : matchedWageByJob !== null
          ? matchedWageByJob
          : matchedSingleWage,
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

    const [employees, analytics, jobs] = await Promise.all([
      fetchToastEmployeesFromVitals({ vitalsRecord, locationName: location }),
      fetchToastAnalyticsJobsFromVitals({
        vitalsRecord,
        periodStart: start,
        periodEnd: end,
        locationName: location,
      }),
      fetchToastJobsFromVitals({ vitalsRecord, locationName: location }),
    ]);

    if (!employees.ok) {
      throw new Error(`toast_employees_failed:${employees.error || 'unknown'}:${formatAnalyticsError(employees)}`);
    }

    if (!analytics.ok) {
      throw new Error(`toast_analytics_failed:${analytics.error || 'unknown'}:${formatAnalyticsError(analytics)}`);
    }

    const employeeRows = extractRows(employees.data);
    const employeeByKey = buildEmployeeIndex(employeeRows);
    const jobRows = jobs?.ok ? extractRows(jobs.data) : [];
    const jobByKey = buildJobIndex(jobRows);
    const rawAnalyticsRows = extractRows(analytics.data);
    const normalizedLaborRows = rawAnalyticsRows.map((row) =>
      normalizeAnalyticsLaborRow(row, {
        location,
        periodStart: start,
        periodEnd: end,
        fallbackLocationCode: vitalsRecord['Toast Location ID'] ? String(vitalsRecord['Toast Location ID']) : null,
      })
    );
    const joinedRows = joinLaborRowsToEmployees(normalizedLaborRows, employeeByKey, jobByKey);
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

    const isBarrio = /barrio/i.test(location);
    const debug =
      includeDebug && isBarrio
        ? buildJoinDiagnostics({
            employeeRows,
            employeeByKey,
            jobRows,
            rawAnalyticsRows,
            normalizedLaborRows,
          })
        : null;

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
        job_metadata_source: jobs?.ok ? `Toast Standard jobs endpoint (${jobs.endpoint || 'unknown'})` : null,
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
