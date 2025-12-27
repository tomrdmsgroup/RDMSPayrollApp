// server/src/domain/exclusionsService.js
//
// Exclusion records are expected to include:
// - toast_employee_id
// - effective_from (optional)
// - effective_to (optional)
// - scope_flags (optional object with boolean flags per surface)

function overlapsPeriod(exclusion, periodStart, periodEnd) {
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  const from = exclusion.effective_from ? new Date(exclusion.effective_from) : null;
  const to = exclusion.effective_to ? new Date(exclusion.effective_to) : null;

  if (from && end < from) return false;
  if (to && start > to) return false;
  return true;
}

// Semantics:
// - scope_flags missing/null => legacy exclude-all (backward compatible)
// - scope_flags present      => exclude only where flag === true
function isScopeExcluded(exclusion, scope) {
  if (exclusion.scope_flags == null) return true;
  if (typeof exclusion.scope_flags !== 'object') return false;
  return exclusion.scope_flags[scope] === true;
}

/**
 * isExcluded
 *
 * Predicate helper (legacy/tests). Prefer buildExcludedEmployeeDecisions
 * for per-run computation.
 */
function isExcluded(exclusions = [], employeeId, targetDate, scopeFlag) {
  if (!employeeId || !scopeFlag) return false;
  if (!targetDate) return false;
  return exclusions.some(
    (ex) =>
      `${ex.toast_employee_id}` === `${employeeId}` &&
      overlapsPeriod(ex, targetDate, targetDate) &&
      isScopeExcluded(ex, scopeFlag)
  );
}

/**
 * buildExcludedEmployeeDecisions
 *
 * Inputs:
 * - exclusions: array of exclusion records for a client/location
 * - periodStart: YYYY-MM-DD
 * - periodEnd: YYYY-MM-DD
 *
 * Output:
 * {
 *   audit: Set<string>,
 *   wip:   Set<string>,
 *   tips:  Set<string>
 * }
 */
function buildExcludedEmployeeDecisions(exclusions = [], periodStart, periodEnd) {
  const decisions = {
    audit: new Set(),
    wip: new Set(),
    tips: new Set(),
  };

  if (!periodStart || !periodEnd) {
    return decisions;
  }

  exclusions.forEach((ex) => {
    if (!ex.toast_employee_id) return;
    if (!overlapsPeriod(ex, periodStart, periodEnd)) return;

    if (isScopeExcluded(ex, 'audit')) decisions.audit.add(ex.toast_employee_id);
    if (isScopeExcluded(ex, 'wip')) decisions.wip.add(ex.toast_employee_id);
    if (isScopeExcluded(ex, 'tips')) decisions.tips.add(ex.toast_employee_id);
  });

  return decisions;
}

module.exports = {
  isExcluded,
  buildExcludedEmployeeDecisions,
};
