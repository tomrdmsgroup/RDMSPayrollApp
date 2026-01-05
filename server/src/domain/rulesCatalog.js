// server/src/domain/rulesCatalog.js
// Static catalog of available payroll validation rules.
// This file is code-owned and does NOT store per-client behavior.

const rulesCatalog = [
  {
    rule_id: 'NEW_EMPLOYEE_ACTIVITY',
    rule_name: 'New employee with payroll activity',
    definition: 'Flags employees with payroll activity who were hired during the current pay period.',
    rationale: 'New hires often require manual review to confirm setup, pay rate, and tax configuration.',
    params_required: false,
    api_type: 'Standard',
    updated_api_type: 'Standard'
  },
  {
    rule_id: 'OVERTIME_THRESHOLD',
    rule_name: 'Overtime hours exceed threshold',
    definition: 'Flags employees whose overtime hours exceed a configured threshold.',
    rationale: 'Unexpected overtime may indicate scheduling issues or incorrect punch data.',
    params_required: true,
    params_hint: 'Number of overtime hours (example: 5)',
    api_type: 'Analytics',
    updated_api_type: 'Analytics'
  },
  {
    rule_id: 'MISSING_PUNCHES',
    rule_name: 'Missing punches',
    definition: 'Flags employees with missing or incomplete time punches.',
    rationale: 'Missing punches can lead to incorrect pay and require manual correction.',
    params_required: false,
    api_type: 'Standard',
    updated_api_type: 'Standard'
  },
  {
    rule_id: 'MIN_WAGE_CHECK',
    rule_name: 'Below minimum wage',
    definition: 'Flags employees whose calculated hourly rate falls below the configured minimum wage.',
    rationale: 'Ensures compliance with federal, state, or local minimum wage requirements.',
    params_required: true,
    params_hint: 'Minimum wage amount (example: 19.18)',
    api_type: 'Analytics',
    updated_api_type: 'Analytics'
  }
];

module.exports = {
  rulesCatalog
};
