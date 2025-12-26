// server/src/domain/exportService.js
//
// Step 3 foundation: WIP + Tips outputs must be XLSX (not CSV).
// - Keeps existing CSV helpers for backwards compatibility (routes currently call generateRunWip()).
// - Adds XLSX generators that:
//   - preserve required headers
//   - support ADP RUN and ADP WFN
//   - filter excluded employees BEFORE writing rows (when excluded ids are provided)
// - Filename rules (exact):
//   - "[Location Name] WIP PPE [DD.MM.YY].xlsx"
//   - "[Location Name] Tips report PPE [DD.MM.YY].xlsx"
//
// Note: this module does NOT fetch Toast data. Caller supplies rows.

const REQUIRED_RUN_COLUMNS = [
  'Batch ID',
  'Company Code',
  'File #',
  'Employee',
  'Reg Hours',
  'OT Hours',
  'Pay Rate',
  'Tips',
];

const REQUIRED_WFN_COLUMNS = [
  'BATCH ID',
  'CO CODE',
  'FILE #',
  'EMPLOYEE',
  'REG HRS',
  'OT HRS',
  'PAY RATE',
  'TIPS',
];

// Optional dependency for XLSX generation.
// If not installed, XLSX generators will throw a clear error.
let ExcelJS = null;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  ExcelJS = require('exceljs');
} catch (e) {
  ExcelJS = null;
}

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

function toDateOnly(d) {
  // Accept Date or YYYY-MM-DD string
  if (!d) return null;
  if (d instanceof Date) return new Date(d.toISOString().slice(0, 10));
  return new Date(`${String(d).slice(0, 10)}T00:00:00.000Z`);
}

function formatPpeDdMmYy(periodEnd) {
  const day = toDateOnly(periodEnd);
  if (!day || Number.isNaN(day.getTime())) return '00.00.00';
  const dd = String(day.getUTCDate()).padStart(2, '0');
  const mm = String(day.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(day.getUTCFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

function buildWipFilename(locationName, periodEnd) {
  return `${locationName} WIP PPE ${formatPpeDdMmYy(periodEnd)}.xlsx`;
}

function buildTipsFilename(locationName, periodEnd) {
  return `${locationName} Tips report PPE ${formatPpeDdMmYy(periodEnd)}.xlsx`;
}

function filterRowsByExcludedEmployeeIds(rows, excludedEmployeeIds) {
  if (!excludedEmployeeIds) return rows;
  const excludedSet =
    excludedEmployeeIds instanceof Set ? excludedEmployeeIds : new Set(excludedEmployeeIds);

  // Expect rows to carry toast_employee_id (or toastEmployeeId).
  return rows.filter((r) => {
    const id = r.toast_employee_id || r.toastEmployeeId || null;
    if (!id) return true; // if row has no id, do not drop silently
    return !excludedSet.has(String(id));
  });
}

// --------------------
// Existing CSV outputs (kept for compatibility)
// --------------------
function generateRunWip(rows) {
  const header = REQUIRED_RUN_COLUMNS.join(',');
  const lines = rows.map((r) => {
    return [
      r.batchId || '',
      r.companyCode || '',
      r.fileNumber || '',
      formatEmployee(r.lastName, r.firstName),
      r.regHours || '',
      r.otHours || '',
      r.payRate || '',
      r.tips || '',
    ].join(',');
  });
  return [header, ...lines].join('\n');
}

function generateWfnWip(rows, wfnCoCode) {
  ensureCoCode({ wfnCoCode });
  const header = REQUIRED_WFN_COLUMNS.join(',');
  const lines = rows.map((r) => {
    return [
      r.batchId || '',
      wfnCoCode,
      r.fileNumber || '',
      formatEmployee(r.lastName, r.firstName),
      r.regHours || '',
      r.otHours || '',
      r.payRate || '',
      r.tips || '',
    ].join(',');
  });
  return [header, ...lines].join('\n');
}

// --------------------
// XLSX outputs (Step 3)
// --------------------
function assertExcelJsAvailable() {
  if (ExcelJS) return;
  const err = new Error(
    'XLSX generation requires exceljs. Install it (npm i exceljs) or change implementation to a repo-approved XLSX library.',
  );
  err.fatal = true;
  throw err;
}

function addWorksheetWithHeader(workbook, sheetName, headerColumns) {
  const ws = workbook.addWorksheet(sheetName);
  ws.addRow(headerColumns);
  ws.getRow(1).font = { bold: true };
  return ws;
}

async function generateRunWipXlsxBuffer({
  rows = [],
  excludedEmployeeIds = null,
  sheetName = 'WIP',
} = {}) {
  assertExcelJsAvailable();

  const filtered = filterRowsByExcludedEmployeeIds(rows, excludedEmployeeIds);

  const workbook = new ExcelJS.Workbook();
  const ws = addWorksheetWithHeader(workbook, sheetName, REQUIRED_RUN_COLUMNS);

  filtered.forEach((r) => {
    ws.addRow([
      r.batchId || '',
      r.companyCode || '',
      r.fileNumber || '',
      formatEmployee(r.lastName, r.firstName),
      r.regHours || '',
      r.otHours || '',
      r.payRate || '',
      r.tips || '',
    ]);
  });

  // Return Buffer
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

async function generateWfnWipXlsxBuffer({
  rows = [],
  wfnCoCode,
  excludedEmployeeIds = null,
  sheetName = 'WIP',
} = {}) {
  assertExcelJsAvailable();
  ensureCoCode({ wfnCoCode });

  const filtered = filterRowsByExcludedEmployeeIds(rows, excludedEmployeeIds);

  const workbook = new ExcelJS.Workbook();
  const ws = addWorksheetWithHeader(workbook, sheetName, REQUIRED_WFN_COLUMNS);

  filtered.forEach((r) => {
    ws.addRow([
      r.batchId || '',
      String(wfnCoCode),
      r.fileNumber || '',
      formatEmployee(r.lastName, r.firstName),
      r.regHours || '',
      r.otHours || '',
      r.payRate || '',
      r.tips || '',
    ]);
  });

  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = {
  // headers (kept exported to freeze contract)
  REQUIRED_RUN_COLUMNS,
  REQUIRED_WFN_COLUMNS,

  // helpers
  formatEmployee,
  formatPpeDdMmYy,
  buildWipFilename,
  buildTipsFilename,
  filterRowsByExcludedEmployeeIds,

  // CSV (existing)
  generateRunWip,
  generateWfnWip,

  // XLSX (Step 3)
  generateRunWipXlsxBuffer,
  generateWfnWipXlsxBuffer,
};
