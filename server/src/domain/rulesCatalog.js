// server/src/domain/rulesCatalog.js
// Static catalog of available payroll validation rules.
// Code-owned. Per-location enablement and parameters live in Postgres via rulesConfigDb.

const rulesCatalog = [
  {
    rule_id: 'NEWEMP',
    rule_name: 'New employee',
    definition: 'Employee not seen in 6 pay periods (name and file id).',
    rationale:
      'Analytics returns employeeGuid plus businessDate. By comparing recent pay periods you can detect a new appearance without persisting all prior data locally.',
    params_required: false
  },
  {
    rule_id: 'NEWRATE',
    rule_name: 'New Pay Rate',
    definition: 'Rate for specific employee and department not seen in prior 6 pay periods.',
    rationale:
      'Rate info (wageCost per hour via regularCost divided by regularHours) can be inferred from aggregated labor data. Standard is not needed if hourly cost suffices.',
    params_required: false
  },
  {
    rule_id: 'NEWDEPT',
    rule_name: 'New Department',
    definition: 'Department for specific employee not seen in prior 6 pay periods.',
    rationale:
      'Department (mapped by jobGuid or jobTitle) is included in Analytics data.',
    params_required: false
  },
  {
    rule_id: 'MISSINGID',
    rule_name: 'Missing Payroll File ID',
    definition: 'Missing Payroll File ID.',
    rationale:
      'Only Standard /labor/v1/employees exposes the payroll or external file ID directly.',
    params_required: false
  },
  {
    rule_id: 'OTTHRESHOLD',
    rule_name: 'OT over X Hours',
    definition: 'Overtime hours (total for employee) over X hours.',
    rationale:
      'overtimeHours field is native in Analytics labor response.',
    params_required: true,
    params_hint: 'Overtime hours threshold (example: 5)'
  },
  {
    rule_id: 'LATECLOCKOUT',
    rule_name: 'Clockout after 2 AM',
    definition:
      'Show any employee who has a shift that clocked out after 2am. Show name and date of shift, and punch in/out time.',
    rationale:
      'Requires actual punch times (inDate/outDate from /labor/v1/timeEntries).',
    params_required: false
  },
  {
    rule_id: 'LONGSHIFT',
    rule_name: 'Shift over X hours',
    definition:
      'Show any specific shift (total hours) that is over X hours. Include date and time in/out.',
    rationale:
      'Must compute shift duration from raw time entries.',
    params_required: true,
    params_hint: 'Shift hours threshold (example: 8)'
  },
  {
    rule_id: '7DAYS',
    rule_name: '7 consecutive days',
    definition:
      'Show any employee who worked more than 7 consecutive days of week.',
    rationale:
      'businessDate aggregation per employee allows detection of consecutive workdays.',
    params_required: false
  },
  {
    rule_id: 'MINWAGE',
    rule_name: 'Under Minimum Wage',
    definition:
      'If wage for staff is under minimum wage, list employee and rate/department.',
    rationale:
      'Hourly cost derivable from regularCost divided by regularHours. Compare to configured minimum wage.',
    params_required: true,
    params_hint: 'Minimum wage amount (example: 19.18)'
  },
  {
    rule_id: 'MISSINGEMP',
    rule_name: 'Employee missing this period',
    definition:
      'Find an employee who had hours in the past 2 pay periods who does not have hours now.',
    rationale:
      'Detect employees missing from current period vs prior via Analytics summaries.',
    params_required: false
  },
  {
    rule_id: 'DUPTIME',
    rule_name: 'Overlapping or duplicate time entries',
    definition: 'See if an edit was done by error and that times overlap.',
    rationale:
      'Only Standard exposes per-shift start/end times needed to find overlaps.',
    params_required: false
  },
  {
    rule_id: 'INACTIVEEMP',
    rule_name: 'Inactive employee used on a shift',
    definition:
      'Did someone use the punch code of the wrong employee or not re-hire an employee.',
    rationale:
      'Employee status (deleted, archived) exists only in /labor/v1/employees.',
    params_required: false
  }
];

module.exports = { rulesCatalog };
