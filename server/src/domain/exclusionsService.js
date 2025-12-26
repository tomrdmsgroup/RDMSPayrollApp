// server/src/domain/exclusionsService.js
// Exclusions Decision Engine
//
// Purpose:
// - Compute excluded employees ONCE per run (location + period)
// - Produce per-surface exclusion decisions
// - Downstream consumers (validation, WIP, tips) must NOT re-evaluate logic
//
// Scope flags supported on exclusion records:
// - audit
// - wip
// - tips
//
// Exclusion records are expected to include:
// - toast_employee_id
// - effective_from (optional)
// - effective_to (optional)
// - scope_flags (object with boolean flags per surface)

function overlapsPeriod(exclusion, periodStart, periodEnd) {
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  const from = exclusion.effective_from ? new Date(exclusion.effective_from) : null;
  const to = exclusion.effective_to ? new Date(exclusion.effective_to) : null;

  if (from && end < from) return false;
  if (to && start > to) return false;
  return true;
}

function isScopeExcluded(exclusion, scope) {
  if (!exclusion.scope_flags) return true;
  if (exclusion.scope_flags[scope] === false) return false;
  return true;
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

    if (isScopeExcluded(ex, 'audit')) {
      decisions.audit.add(ex.toast_employee_id);
    }

    if (isScopeExcluded(ex, 'wip')) {
      decisions.wip.add(ex.toast_employee_id);
    }

    if (isScopeExcluded(ex, 'tips')) {
      decisions.tips.add(ex.toast_employee_id);
    }
  });

  return decisions;
}

module.exports = {
  buildExcludedEmployeeDecisions,
};
