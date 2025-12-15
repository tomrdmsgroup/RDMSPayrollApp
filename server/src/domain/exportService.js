const REQUIRED_RUN_COLUMNS = ['Batch ID', 'Company Code', 'File #', 'Employee', 'Reg Hours', 'OT Hours', 'Pay Rate', 'Tips'];
const REQUIRED_WFN_COLUMNS = ['BATCH ID', 'CO CODE', 'FILE #', 'EMPLOYEE', 'REG HRS', 'OT HRS', 'PAY RATE', 'TIPS'];

function formatEmployee(last, first) {
  return `${last || ''}, ${first || ''}`.trim();
}

function ensureCoCode(data) {
  if (!data.wfnCoCode) {
    const err = new Error('Missing WFN CO CODE');
    err.fatal = true;
    throw err;
  }
}

function generateRunWip(rows) {
  const header = REQUIRED_RUN_COLUMNS.join(',');
  const lines = rows.map((r) => {
    return [r.batchId || '', r.companyCode || '', r.fileNumber || '', formatEmployee(r.lastName, r.firstName), r.regHours || '', r.otHours || '', r.payRate || '', r.tips || ''].join(',');
  });
  return [header, ...lines].join('\n');
}

function generateWfnWip(rows, wfnCoCode) {
  ensureCoCode({ wfnCoCode });
  const header = REQUIRED_WFN_COLUMNS.join(',');
  const lines = rows.map((r) => {
    return [r.batchId || '', wfnCoCode, r.fileNumber || '', formatEmployee(r.lastName, r.firstName), r.regHours || '', r.otHours || '', r.payRate || '', r.tips || ''].join(',');
  });
  return [header, ...lines].join('\n');
}

module.exports = { generateRunWip, generateWfnWip, formatEmployee };
