// server/src/domain/validationEngine.js
// Validation Findings Layer (first-pass real implementation for NEWEMP/NEWRATE/NEWDEPT).

const { buildExcludedEmployeeDecisions } = require('./exclusionsService');
const { fetchVitalsSnapshot } = require('../providers/vitalsProvider');
const {
  fetchToastTimeEntriesFromVitals,
  fetchToastEmployeesFromVitals,
  fetchToastJobsFromVitals,
} = require('../providers/toastProvider');
const { rulesCatalog } = require('./rulesCatalog');

const SUPPORTED_RULE_IDS = new Set([
  'NEWEMP',
  'NEWRATE',
  'NEWDEPT',
  'MISSINGID',
  'OTTHRESHOLD',
  'MINWAGE',
  'LATECLOCKOUT',
  'LONGSHIFT',
  'DUPTIME',
]);

function trimErrorText(value, maxLen = 1800) {
  const s = String(value || '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…[truncated ${s.length - maxLen} chars]`;
}

function formatProviderError(providerResult) {
  const payload = {
    status: providerResult?.status || null,
    request: providerResult?.request || null,
    details: providerResult?.details || null,
    error: providerResult?.error || null,
  };
  return trimErrorText(JSON.stringify(payload));
}

function normalizeSeverity(severity) {
  const s = (severity || '').toLowerCase();
  if (['info', 'warn', 'warning', 'error'].includes(s)) {
    return s === 'warning' ? 'warn' : s;
  }
  return 'warn';
}

function normalizeStatus(status) {
  const s = (status || '').toLowerCase();
  if (['ok', 'warning', 'failure', 'error'].includes(s)) return s;
  return 'failure';
}

function makeFinding({
  code,
  message,
  details = null,
  severity = 'warn',
  status = 'failure',
  emit_asana_alert = false,
}) {
  return {
    code,
    message,
    details,
    severity: normalizeSeverity(severity),
    status: normalizeStatus(status),
    emit_asana_alert: emit_asana_alert === true,
  };
}

function getRuleCatalog() {
  return rulesCatalog;
}


function mergeCatalogWithActiveRuleConfigs(ruleCatalog, activeRuleConfigs) {
  const catalog = Array.isArray(ruleCatalog) ? ruleCatalog : [];
  const activeConfigsByRuleId = activeRuleConfigs && typeof activeRuleConfigs === 'object' ? activeRuleConfigs : null;
  if (!activeConfigsByRuleId) return catalog;

  return catalog.map((rule) => {
    const config = activeConfigsByRuleId[rule?.rule_id];
    if (!config || config.params === undefined) return rule;
    return { ...rule, params: config.params };
  });
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickString(obj, keys = []) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value === undefined || value === null) continue;
    const s = String(value).trim();
    if (s) return s;
  }
  return null;
}

function extractRows(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.employees)) return payload.employees;
  return [];
}

function safeTrim(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}

function formatLastFirst(firstName, lastName) {
  const first = safeTrim(firstName) || '';
  const last = safeTrim(lastName) || '';
  if (last && first) return `${last}, ${first}`;
  return last || first || null;
}

function normalizeStandardValidationRows({ timeEntryRows, employeeRows, jobRows }) {
  const employeesByGuid = new Map();
  for (const employee of Array.isArray(employeeRows) ? employeeRows : []) {
    const guid = safeTrim(employee?.guid);
    if (guid) employeesByGuid.set(guid, employee);

    const v2Guid = safeTrim(employee?.v2EmployeeGuid);
    if (v2Guid && !employeesByGuid.has(v2Guid)) employeesByGuid.set(v2Guid, employee);
  }

  const jobsByGuid = new Map();
  for (const job of Array.isArray(jobRows) ? jobRows : []) {
    const guid = safeTrim(job?.guid);
    if (guid) jobsByGuid.set(guid, job);
  }

  const rows = [];
  for (const timeEntry of Array.isArray(timeEntryRows) ? timeEntryRows : []) {
    const employeeGuid =
      safeTrim(timeEntry?.employeeReference?.guid) || safeTrim(timeEntry?.employeeGuid) || safeTrim(timeEntry?.employeeId);
    const jobGuid = safeTrim(timeEntry?.jobReference?.guid) || safeTrim(timeEntry?.jobGuid) || safeTrim(timeEntry?.jobId);

    const employee = employeeGuid ? employeesByGuid.get(employeeGuid) || null : null;
    const job = jobGuid ? jobsByGuid.get(jobGuid) || null : null;

    const employeeName =
      formatLastFirst(employee?.firstName, employee?.lastName) ||
      safeTrim(employee?.chosenName) ||
      safeTrim(employee?.name) ||
      safeTrim(employee?.fullName) ||
      safeTrim(timeEntry?.employeeName) ||
      null;

    const externalEmployeeId =
      safeTrim(employee?.externalEmployeeId) || safeTrim(employee?.externalId) || safeTrim(timeEntry?.externalEmployeeId) || null;

    const jobTitle = safeTrim(job?.title) || safeTrim(timeEntry?.jobTitle) || safeTrim(timeEntry?.jobName) || null;
    const jobCode = safeTrim(job?.code) || safeTrim(timeEntry?.jobCode) || null;

    rows.push({
      employeeGuid: employeeGuid || null,
      employeeId: employeeGuid || null,
      toast_employee_id: employeeGuid || null,
      employeeName,
      externalEmployeeId,
      payrollFileId: externalEmployeeId,
      jobGuid: jobGuid || null,
      jobName: jobTitle,
      jobTitle,
      departmentName: jobTitle,
      jobCode,
      hourlyRate: toNum(timeEntry?.hourlyWage),
      payRate: toNum(timeEntry?.hourlyWage),
      rate: toNum(timeEntry?.hourlyWage),
      regularHours: toNum(timeEntry?.regularHours) ?? toNum(timeEntry?.hoursRegular),
      overtimeHours: toNum(timeEntry?.overtimeHours) ?? toNum(timeEntry?.hoursOvertime),
      businessDate: timeEntry?.businessDate || null,
      inDate: timeEntry?.inDate || null,
      outDate: timeEntry?.outDate || null,
    });
  }

  return rows;
}

function normalizeRateAmount(row) {
  const explicit = toNum(row?.hourlyRate) ?? toNum(row?.payRate) ?? toNum(row?.rate);
  if (explicit !== null && explicit > 0) return explicit;

  const regularHours =
    toNum(row?.regularHours) ?? toNum(row?.hoursRegular) ?? toNum(row?.hours) ?? toNum(row?.totalHours);
  const regularCost =
    toNum(row?.regularCost) ?? toNum(row?.wageCost) ?? toNum(row?.laborCost) ?? toNum(row?.totalLaborCost);

  if (!regularHours || regularHours <= 0 || regularCost === null) return null;
  const derived = regularCost / regularHours;
  if (!Number.isFinite(derived) || derived <= 0) return null;

  return derived;
}

function normalizeDepartmentName(row) {
  return (
    pickString(row, ['jobName', 'jobTitle', 'job', 'departmentName', 'department', 'laborDepartmentName']) ||
    pickString(row?.job || {}, ['name', 'title']) ||
    'Unknown Department'
  );
}

function normalizeEmployeeId(row) {
  return (
    pickString(row, ['employeeGuid', 'employeeId', 'employeeUUID', 'employee', 'toast_employee_id']) ||
    pickString(row?.employee || {}, ['guid', 'id', 'employeeGuid'])
  );
}

function normalizeEmployeeName(row) {
  return (
    pickString(row, ['employeeName', 'fullName', 'employeeFullName', 'name']) ||
    pickString(row?.employee || {}, ['fullName', 'name'])
  );
}

function formatRate(rate) {
  return Number(rate).toFixed(2);
}

function parseValidDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sanitizeTimeZone(timeZone) {
  const tz = safeTrim(timeZone);
  if (!tz) return null;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch (_err) {
    return null;
  }
}

function formatClockTime(date, timeZone = null) {
  const opts = { hour: 'numeric', minute: '2-digit', hour12: true };
  if (timeZone) opts.timeZone = timeZone;
  return date.toLocaleTimeString('en-US', opts);
}

function formatDateYmd(date, timeZone = null) {
  if (!timeZone) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function minutesInDay(date, timeZone = null) {
  if (!timeZone) return date.getHours() * 60 + date.getMinutes();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value || '0');
  return hour * 60 + minute;
}

function parseRuleParams(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    const asNum = Number(t);
    if (Number.isFinite(asNum)) return asNum;
    try {
      return JSON.parse(t);
    } catch (_err) {
      return null;
    }
  }
  if (typeof raw === 'object') return raw;
  return null;
}

function extractNumericRuleThreshold(rule, keys = []) {
  const parsed = parseRuleParams(rule?.params);
  if (typeof parsed === 'number') return parsed;
  if (parsed && typeof parsed === 'object') {
    for (const key of keys) {
      const n = toNum(parsed[key]);
      if (n !== null) return n;
    }
  }
  return null;
}

function ruleMap(catalog) {
  const map = new Map();
  for (const rule of catalog || []) {
    if (!rule?.rule_id) continue;
    map.set(rule.rule_id, rule);
  }
  return map;
}

function resolveActiveSupportedRules(activeRuleIds = [], catalog = getRuleCatalog()) {
  const input = new Set((Array.isArray(activeRuleIds) ? activeRuleIds : []).map((x) => String(x || '').trim()));
  const out = new Set();
  if (input.size === 0) {
    for (const id of SUPPORTED_RULE_IDS) out.add(id);
    return out;
  }

  for (const id of input) {
    if (SUPPORTED_RULE_IDS.has(id)) out.add(id);
  }

  return out;
}

async function fetchToastRowsForPeriods({
  clientLocationId,
  periods = [],
  deps = {
    fetchVitalsSnapshot,
    fetchToastEmployeesFromVitals,
    fetchToastJobsFromVitals,
    fetchToastTimeEntriesFromVitals,
  },
}) {
  const snapshot = await deps.fetchVitalsSnapshot(clientLocationId);
  const vitalsRecord = (snapshot && snapshot.data && snapshot.data[0]) || null;
  if (!vitalsRecord) throw new Error('toast_vitals_not_found');

  const employees = await deps.fetchToastEmployeesFromVitals({
    vitalsRecord,
    locationName: clientLocationId,
  });

  if (!employees?.ok) {
    throw new Error(`toast_employees_failed:${employees?.error || 'unknown'}:${formatProviderError(employees)}`);
  }

  const jobs = await deps.fetchToastJobsFromVitals({
    vitalsRecord,
    locationName: clientLocationId,
  });

  if (!jobs?.ok) {
    throw new Error(`toast_jobs_failed:${jobs?.error || 'unknown'}:${formatProviderError(jobs)}`);
  }

  const employeeRows = extractRows(employees.data);
  const jobRows = extractRows(jobs.data);
  const endpoints = ['/labor/v1/timeEntries', '/labor/v1/employees', '/labor/v1/jobs'];

  const rowsByPeriod = {};
  const sourceMeta = [];

  for (const [index, period] of (periods || []).entries()) {
    if (!period?.period_start || !period?.period_end) continue;
    const key = `${period.period_start}__${period.period_end}`;

    const timeEntries = await deps.fetchToastTimeEntriesFromVitals({
      vitalsRecord,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      locationName: clientLocationId,
    });

    if (!timeEntries?.ok) {
      throw new Error(`toast_time_entries_failed:${timeEntries?.error || 'unknown'}:${formatProviderError(timeEntries)}`);
    }

    const timeEntryRows = extractRows(timeEntries.data);
    const normalizedRows = normalizeStandardValidationRows({
      timeEntryRows,
      employeeRows,
      jobRows,
    });

    rowsByPeriod[key] = normalizedRows;
    sourceMeta.push({
      source: 'toast_standard_labor',
      endpoints,
      period_start: period.period_start,
      period_end: period.period_end,
      comparison_role: index === 0 ? 'selected' : 'prior',
      date_range: `${period.period_start}..${period.period_end}`,
      row_count: normalizedRows.length,
    });
  }

  return {
    rowsByPeriod,
    sourceMeta,
  };
}

function buildFindings({ rowsByPeriod, selectedPeriod, priorPeriods, excludedAuditIds, activeRuleIds, catalog, timeZone = null }) {
  const findings = [];
  const selectedKey = `${selectedPeriod.period_start}__${selectedPeriod.period_end}`;
  const selectedRows = Array.isArray(rowsByPeriod[selectedKey]) ? rowsByPeriod[selectedKey] : [];
  const priorKeys = priorPeriods.map((p) => `${p.period_start}__${p.period_end}`);

  const employeeNames = new Map();
  const selectedEmployees = new Set();
  const priorEmployees = new Set();

  const selectedEmpDept = new Set();
  const priorEmpDept = new Set();

  const selectedEmpDeptRate = new Map();
  const priorEmpDeptRate = new Set();

  function touchName(id, candidate) {
    if (!id || !candidate) return;
    if (!employeeNames.has(id)) employeeNames.set(id, candidate);
  }

  for (const row of selectedRows) {
    const employeeId = normalizeEmployeeId(row);
    if (!employeeId) continue;

    touchName(employeeId, normalizeEmployeeName(row));
    selectedEmployees.add(employeeId);

    const deptName = normalizeDepartmentName(row);
    const deptKey = `${employeeId}::${deptName}`;
    selectedEmpDept.add(deptKey);

    const rate = normalizeRateAmount(row);
    if (rate !== null) {
      const normalizedRate = formatRate(rate);
      const rateKey = `${deptKey}::${normalizedRate}`;
      if (!selectedEmpDeptRate.has(rateKey)) {
        selectedEmpDeptRate.set(rateKey, {
          employeeId,
          deptName,
          rate: normalizedRate,
        });
      }
    }
  }

  for (const key of priorKeys) {
    const rows = Array.isArray(rowsByPeriod[key]) ? rowsByPeriod[key] : [];
    for (const row of rows) {
      const employeeId = normalizeEmployeeId(row);
      if (!employeeId) continue;

      touchName(employeeId, normalizeEmployeeName(row));
      priorEmployees.add(employeeId);

      const deptName = normalizeDepartmentName(row);
      const deptKey = `${employeeId}::${deptName}`;
      priorEmpDept.add(deptKey);

      const rate = normalizeRateAmount(row);
      if (rate !== null) {
        const rateKey = `${deptKey}::${formatRate(rate)}`;
        priorEmpDeptRate.add(rateKey);
      }
    }
  }

  const catalogByRule = ruleMap(catalog);

  if (activeRuleIds.has('NEWEMP')) {
    for (const employeeId of selectedEmployees) {
      if (excludedAuditIds.has(employeeId)) continue;
      if (priorEmployees.has(employeeId)) continue;

      const rule = catalogByRule.get('NEWEMP');
      findings.push({
        employee_name: employeeNames.get(employeeId) || `Employee ${employeeId}`,
        toast_employee_id: employeeId,
        rule_id: 'NEWEMP',
        rule_name: rule?.rule_name || 'New employee',
        detail: 'Employee not seen in prior 6 pay periods',
      });
    }
  }

  if (activeRuleIds.has('NEWDEPT')) {
    for (const deptKey of selectedEmpDept) {
      if (priorEmpDept.has(deptKey)) continue;
      const [employeeId, deptName] = deptKey.split('::');
      if (excludedAuditIds.has(employeeId)) continue;

      const rule = catalogByRule.get('NEWDEPT');
      findings.push({
        employee_name: employeeNames.get(employeeId) || `Employee ${employeeId}`,
        toast_employee_id: employeeId,
        rule_id: 'NEWDEPT',
        rule_name: rule?.rule_name || 'New Department',
        detail: `New department ${deptName} not seen for this employee in prior 6 pay periods`,
      });
    }
  }

  if (activeRuleIds.has('NEWRATE')) {
    for (const [rateKey, info] of selectedEmpDeptRate.entries()) {
      if (priorEmpDeptRate.has(rateKey)) continue;
      if (excludedAuditIds.has(info.employeeId)) continue;

      const rule = catalogByRule.get('NEWRATE');
      findings.push({
        employee_name: employeeNames.get(info.employeeId) || `Employee ${info.employeeId}`,
        toast_employee_id: info.employeeId,
        rule_id: 'NEWRATE',
        rule_name: rule?.rule_name || 'New Pay Rate',
        detail: `New rate ${info.rate} for ${info.deptName} not seen in prior 6 pay periods`,
      });
    }
  }

  if (activeRuleIds.has('MISSINGID')) {
    const seen = new Set();
    for (const row of selectedRows) {
      const employeeId = normalizeEmployeeId(row);
      if (!employeeId || seen.has(employeeId) || excludedAuditIds.has(employeeId)) continue;
      const payrollFileId = safeTrim(row?.payrollFileId);
      if (payrollFileId) continue;
      seen.add(employeeId);

      const rule = catalogByRule.get('MISSINGID');
      findings.push({
        employee_name: employeeNames.get(employeeId) || `Employee ${employeeId}`,
        toast_employee_id: employeeId,
        rule_id: 'MISSINGID',
        rule_name: rule?.rule_name || 'Missing Payroll File ID',
        detail: 'Employee has hours in selected period but is missing Payroll File ID',
      });
    }
  }

  if (activeRuleIds.has('OTTHRESHOLD')) {
    const rule = catalogByRule.get('OTTHRESHOLD');
    const threshold = extractNumericRuleThreshold(rule, ['threshold', 'hours', 'value', 'maxHours', 'overtimeHours']);
    if (threshold !== null) {
      const overtimeByEmployee = new Map();
      for (const row of selectedRows) {
        const employeeId = normalizeEmployeeId(row);
        if (!employeeId || excludedAuditIds.has(employeeId)) continue;
        const overtime = toNum(row?.overtimeHours) ?? 0;
        overtimeByEmployee.set(employeeId, (overtimeByEmployee.get(employeeId) || 0) + overtime);
      }

      for (const [employeeId, totalOvertime] of overtimeByEmployee.entries()) {
        if (!(totalOvertime > threshold)) continue;
        findings.push({
          employee_name: employeeNames.get(employeeId) || `Employee ${employeeId}`,
          toast_employee_id: employeeId,
          rule_id: 'OTTHRESHOLD',
          rule_name: rule?.rule_name || 'OT over X Hours',
          detail: `Overtime hours ${totalOvertime} exceed threshold ${threshold}`,
        });
      }
    }
  }

  if (activeRuleIds.has('MINWAGE')) {
    const rule = catalogByRule.get('MINWAGE');
    const minimumWage = extractNumericRuleThreshold(rule, ['minimumWage', 'minWage', 'threshold', 'rate', 'value']);
    if (minimumWage !== null) {
      const seen = new Set();
      for (const row of selectedRows) {
        const employeeId = normalizeEmployeeId(row);
        if (!employeeId || excludedAuditIds.has(employeeId)) continue;

        const rate = normalizeRateAmount(row);
        if (rate === null || rate >= minimumWage) continue;

        const deptName = normalizeDepartmentName(row);
        const rateText = formatRate(rate);
        const key = `${employeeId}::${deptName}::${rateText}`;
        if (seen.has(key)) continue;
        seen.add(key);

        findings.push({
          employee_name: employeeNames.get(employeeId) || `Employee ${employeeId}`,
          toast_employee_id: employeeId,
          rule_id: 'MINWAGE',
          rule_name: rule?.rule_name || 'Under Minimum Wage',
          detail: `Rate ${rateText} for ${deptName} is below minimum wage ${minimumWage}`,
        });
      }
    }
  }

  if (activeRuleIds.has('LATECLOCKOUT')) {
    const rule = catalogByRule.get('LATECLOCKOUT');
    for (const row of selectedRows) {
      const employeeId = normalizeEmployeeId(row);
      if (!employeeId || excludedAuditIds.has(employeeId)) continue;
      const inDate = parseValidDate(row?.inDate);
      const outDate = parseValidDate(row?.outDate);
      if (!outDate) continue;
      const outMinutes = minutesInDay(outDate, timeZone);
      if (outMinutes <= 210 || outMinutes >= 720) continue;
      findings.push({
        employee_name: employeeNames.get(employeeId) || normalizeEmployeeName(row) || `Employee ${employeeId}`,
        toast_employee_id: employeeId,
        rule_id: 'LATECLOCKOUT',
        rule_name: rule?.rule_name || 'Clockout after 3:30 AM',
        detail: `Clockout after 3:30 AM on ${formatDateYmd(outDate, timeZone)}: in ${
          inDate ? formatClockTime(inDate, timeZone) : 'Unknown'
        }, out ${formatClockTime(outDate, timeZone)}`,
      });
    }
  }

  if (activeRuleIds.has('LONGSHIFT')) {
    const rule = catalogByRule.get('LONGSHIFT');
    const threshold = extractNumericRuleThreshold(rule, ['threshold', 'hours', 'value', 'maxHours', 'shiftHours']);
    if (threshold !== null) {
      for (const row of selectedRows) {
        const employeeId = normalizeEmployeeId(row);
        if (!employeeId || excludedAuditIds.has(employeeId)) continue;
        const inDate = parseValidDate(row?.inDate);
        const outDate = parseValidDate(row?.outDate);
        if (!inDate || !outDate) continue;
        const durationHours = (outDate.getTime() - inDate.getTime()) / 3600000;
        if (!Number.isFinite(durationHours) || durationHours <= threshold) continue;
        const rounded = Number(durationHours.toFixed(2));
        findings.push({
          employee_name: employeeNames.get(employeeId) || normalizeEmployeeName(row) || `Employee ${employeeId}`,
          toast_employee_id: employeeId,
          rule_id: 'LONGSHIFT',
          rule_name: rule?.rule_name || 'Shift over X hours',
          detail: `Shift length ${rounded} hours exceeds threshold ${threshold} on ${formatDateYmd(
            inDate,
            timeZone
          )}: in ${formatClockTime(inDate, timeZone)}, out ${formatClockTime(outDate, timeZone)}`,
        });
      }
    }
  }

  if (activeRuleIds.has('DUPTIME')) {
    const rule = catalogByRule.get('DUPTIME');
    const rowsByEmployee = new Map();
    for (const row of selectedRows) {
      const employeeId = normalizeEmployeeId(row);
      if (!employeeId || excludedAuditIds.has(employeeId)) continue;
      const inDate = parseValidDate(row?.inDate);
      const outDate = parseValidDate(row?.outDate);
      if (!inDate || !outDate) continue;
      const range = { inDate, outDate };
      if (!rowsByEmployee.has(employeeId)) rowsByEmployee.set(employeeId, []);
      rowsByEmployee.get(employeeId).push(range);
    }

    for (const [employeeId, ranges] of rowsByEmployee.entries()) {
      ranges.sort((a, b) => a.inDate.getTime() - b.inDate.getTime());
      for (let i = 0; i < ranges.length; i += 1) {
        for (let j = i + 1; j < ranges.length; j += 1) {
          const a = ranges[i];
          const b = ranges[j];
          const overlaps = a.inDate < b.outDate && b.inDate < a.outDate;
          if (!overlaps) continue;
          findings.push({
            employee_name: employeeNames.get(employeeId) || `Employee ${employeeId}`,
            toast_employee_id: employeeId,
            rule_id: 'DUPTIME',
            rule_name: rule?.rule_name || 'Overlapping or duplicate time entries',
            detail: `Overlapping time entries on ${formatDateYmd(a.inDate, timeZone)}: ${formatClockTime(
              a.inDate,
              timeZone
            )}-${formatClockTime(a.outDate, timeZone)} overlaps ${formatClockTime(b.inDate, timeZone)}-${formatClockTime(
              b.outDate,
              timeZone
            )}`,
          });
        }
      }
    }
  }

  findings.sort((a, b) => {
    const aName = String(a.employee_name || '').toLowerCase();
    const bName = String(b.employee_name || '').toLowerCase();
    if (aName !== bName) return aName.localeCompare(bName);
    if (a.rule_id !== b.rule_id) return String(a.rule_id).localeCompare(String(b.rule_id));
    return String(a.detail || '').localeCompare(String(b.detail || ''));
  });

  return findings;
}

/**
 * runValidation
 */
async function runValidation({
  run,
  context,
  exclusions = [],
  ruleCatalog = getRuleCatalog(),
}) {
  const periodStart = run?.period_start || context?.periodStart;
  const periodEnd = run?.period_end || context?.periodEnd;

  const exclusionDecisions = buildExcludedEmployeeDecisions(exclusions, periodStart, periodEnd);

  const selectedPeriod = {
    period_start: periodStart,
    period_end: periodEnd,
  };
  const priorPeriods = Array.isArray(context?.comparison_periods) ? context.comparison_periods.slice(0, 6) : [];
  const periodsToLoad = [selectedPeriod, ...priorPeriods];

  const effectiveRuleCatalog = mergeCatalogWithActiveRuleConfigs(ruleCatalog, context?.active_rule_configs);
  const activeRuleIds = resolveActiveSupportedRules(context?.active_rule_ids, effectiveRuleCatalog);
  const timeZone = sanitizeTimeZone(
    context?.location_timezone || context?.timezone || run?.location_timezone || run?.timezone || run?.payload?.timezone
  );

  const toast = context?.toast_rows_by_period
    ? { rowsByPeriod: context.toast_rows_by_period, sourceMeta: context?.toast_source_meta || [] }
    : await fetchToastRowsForPeriods({
        clientLocationId: run?.client_location_id,
        periods: periodsToLoad,
      });

  const findings = buildFindings({
    rowsByPeriod: toast.rowsByPeriod,
    selectedPeriod,
    priorPeriods,
    excludedAuditIds: exclusionDecisions.audit,
    activeRuleIds,
    catalog: effectiveRuleCatalog,
    timeZone,
  });

  return {
    run_id: run?.id || null,
    findings,
    exclusion_decisions: {
      audit: Array.from(exclusionDecisions.audit),
      wip: Array.from(exclusionDecisions.wip),
      tips: Array.from(exclusionDecisions.tips),
    },
    data_sources: toast.sourceMeta,
    comparison_window: {
      selected_period: selectedPeriod,
      prior_periods: priorPeriods,
      prior_periods_count: priorPeriods.length,
    },
  };
}

module.exports = {
  runValidation,
  makeFinding,
  getRuleCatalog,
  __test: {
    fetchToastRowsForPeriods,
    normalizeStandardValidationRows,
  },
};
