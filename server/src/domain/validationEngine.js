// server/src/domain/validationEngine.js
// Validation Findings Layer (foundation).
//
// Responsibilities:
// - Produce Findings in a stable contract
// - Apply exclusion decisions ONLY for audit/validation scope
// - Surface exclusion decisions so downstream layers (WIP, tips) can reuse them
//
// System failures are NOT findings and must go through failureService.

const { buildExcludedEmployeeDecisions } = require('./exclusionsService');

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

// Placeholder: binder-backed rule catalog will replace this
function getRuleCatalog() {
  return [];
}

/**
 * runValidation
 *
 * Inputs:
 * - run: { id, client_location_id, period_start, period_end }
 * - context: future rule context
 * - exclusions: array of exclusion rows for this client/location
 *
 * Output:
 * - findings
 * - exclusion_decisions (audit/wip/tips)
 */
async function runValidation({
  run,
  context,
  exclusions = [],
  ruleCatalog = getRuleCatalog(),
}) {
  const findings = [];

  const periodStart = run?.period_start || context?.periodStart;
  const periodEnd = run?.period_end || context?.periodEnd;

  const exclusionDecisions = buildExcludedEmployeeDecisions(
    exclusions,
    periodStart,
    periodEnd
  );

  // NOTE:
  // When real rules are implemented, they must:
  // - evaluate employees
  // - skip employees in exclusionDecisions.audit
  // Validation is the ONLY place audit exclusions apply.

  return {
    run_id: run?.id || null,
    findings,
    exclusion_decisions: {
      audit: Array.from(exclusionDecisions.audit),
      wip: Array.from(exclusionDecisions.wip),
      tips: Array.from(exclusionDecisions.tips),
    },
  };
}

module.exports = {
  runValidation,
  makeFinding,
  getRuleCatalog,
};
