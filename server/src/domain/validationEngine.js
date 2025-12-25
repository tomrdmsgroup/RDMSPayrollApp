// server/src/domain/validationEngine.js
// Validation Findings Layer (foundation).
// - Produces Findings in a stable contract for UI / export / Asana consumers.
// - System failures (API down/auth/etc.) are NOT findings; they go through failureService.
//
// Exclusions policy:
// - exclusions list is supplied by caller (routes/service) as an array of records.
// - per-run exclusion behavior is controlled by exclusionPolicy flags passed in.
// - this engine returns excluded_employee_ids so other layers (WIP export, tips, etc.) can filter deterministically.

const { buildExcludedEmployeeSet } = require('./exclusionsService');

function normalizeSeverity(severity) {
  const s = (severity || '').toLowerCase();
  if (s === 'info' || s === 'warn' || s === 'warning' || s === 'error') return s === 'warning' ? 'warn' : s;
  return 'warn';
}

// Status words chosen to be human/report friendly and compatible with prior expectations.
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

// Placeholder: later we will load binder-backed rule catalog here (single source of truth).
function getRuleCatalog() {
  return [];
}

/**
 * runValidation()
 *
 * Inputs:
 * - run: { id, client_location_id, period_start, period_end }
 * - context: any additional data needed for rules later
 * - exclusions: array of exclusion rows for this client_location_id
 * - exclusionPolicy:
 *    {
 *      apply_to_validation: boolean,  // excluded employees are ignored by validation rules
 *      apply_to_wip: boolean,         // excluded employees are removed from WIP export rows (used by export layer)
 *      apply_to_tips: boolean         // excluded employees are removed from tip outputs (used by tips layer)
 *    }
 *
 * Output:
 * - findings: stable finding contract
 * - excluded_employee_ids: list of toast_employee_id strings that overlap the run period
 * - exclusion_policy: echo back what was applied
 */
async function runValidation({
  run,
  context,
  exclusions = [],
  ruleCatalog = getRuleCatalog(),
  exclusionPolicy = {
    apply_to_validation: true,
    apply_to_wip: true,
    apply_to_tips: true,
  },
}) {
  const findings = [];

  const periodStart = run?.period_start || context?.periodStart;
  const periodEnd = run?.period_end || context?.periodEnd;

  const excludedSet =
    periodStart && periodEnd ? buildExcludedEmployeeSet(exclusions, periodStart, periodEnd) : new Set();

  // Later: when we implement actual rules, we will pass excludedSet into rule context
  // and only skip employees if exclusionPolicy.apply_to_validation is true.

  return {
    run_id: run?.id || null,
    findings,
    excluded_employee_ids: Array.from(excludedSet),
    exclusion_policy: {
      apply_to_validation: exclusionPolicy.apply_to_validation === true,
      apply_to_wip: exclusionPolicy.apply_to_wip === true,
      apply_to_tips: exclusionPolicy.apply_to_tips === true,
    },
  };
}

module.exports = { runValidation, makeFinding, getRuleCatalog };
