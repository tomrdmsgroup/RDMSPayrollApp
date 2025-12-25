function isExcluded(exclusions, employeeId, targetDate = new Date(), scopeFlag = null) {
  const day = new Date(targetDate.toISOString().slice(0, 10));
  return exclusions.some((ex) => {
    if (ex.toast_employee_id !== employeeId) return false;
    if (scopeFlag && ex.scope_flags && ex.scope_flags[scopeFlag] === false) return false;
    const from = ex.effective_from ? new Date(ex.effective_from) : null;
    const to = ex.effective_to ? new Date(ex.effective_to) : null;
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  });
}

function buildExcludedEmployeeSet(exclusions, periodStart, periodEnd, scopeFlag = null) {
  const excluded = new Set();
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  exclusions.forEach((ex) => {
    const from = ex.effective_from ? new Date(ex.effective_from) : null;
    const to = ex.effective_to ? new Date(ex.effective_to) : null;

    // check if exclusion overlaps the run period
    if (from && end < from) return;
    if (to && start > to) return;

    // respect scope flag (exclude_wip / exclude_tips / exclude_validation)
    if (scopeFlag && ex.scope_flags && ex.scope_flags[scopeFlag] === false) return;

    excluded.add(ex.toast_employee_id);
  });

  return excluded;
}

module.exports = { isExcluded, buildExcludedEmployeeSet };
