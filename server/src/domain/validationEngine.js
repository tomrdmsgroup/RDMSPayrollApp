// server/src/domain/validationEngine.js
// Validation Findings Layer (foundation).
// - Produces Findings in a stable contract for UI / export / Asana consumers.
// - System failures (API down/auth/etc.) are NOT findings; they go through failureService.
//
// IMPORTANT:
// - This engine does NOT decide exclusions.
// - It CONSUMES exclusion decisions passed in by the run orchestration layer.
// - It only applies audit-level exclusion (skip evaluation).

function normalizeSeverity(severity) {
  const s = (severity || '').toLowerCase();
  if (s === 'info' || s === 'warn' || s === 'warning' || s === 'error') {
    return s === 'warning' ? 'warn' : s;
  }
  return 'warn';
}

function normalizeStatus(status) {
  const s = (status || '').toLowerCase();
  if (s === 'ok' || s === 'warning' || s === 'failure' || s === 'error') return s;
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

// Placeholder: binder-backed rule catalog will be loaded later.
function getRuleCatalog() {
  return [];
}

/**
 * runValidation
 *
 * Inputs:
 * - run: run record
 * - context: shared context for rules
 * - auditExclusions: Set<string> of toast_employee_id to exclude from validation
 *
 * Output:
 * - findings ONLY (no exclusion logic, no export logic)
 */
async function runValidation({
  run,
  context,
  auditExclusions = new Set(),
  ruleCatalog = getRuleCatalog(),
}) {
  const findings = [];

  // When rules exist:
  // - iterate employees
  // - skip employee if auditExclusions.has(employee.toast_employee_id)
  // - rules operate only on included employees

  return {
    run_id: run?.id || null,
    findings,
  };
}

module.exports = { runValidation, makeFinding, getRuleCatalog };
