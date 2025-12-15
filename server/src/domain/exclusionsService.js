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

module.exports = { isExcluded };
