let ExcelJS = null;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  ExcelJS = require('exceljs');
} catch (e) {
  ExcelJS = null;
}

const ADP_RUN_HEADERS = [
  'IID',
  'Pay Frequency',
  'Pay Period Start',
  'Pay Period End',
  'Employee Name (To Delete)',
  'Employee Id',
  'Earnings Code',
  'Pay Hours',
  'Dollars',
  'Separate Check',
  'Department Name (To Delete)',
  'Department Number',
  'Rate Code',
  'Rate Amount (To Delete)',
];

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function toMMDDYYYY(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value).replace(/[$,%\s]/g, '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function pick(row, aliases) {
  const source = row && typeof row === 'object' ? row : {};
  const keys = Object.keys(source);
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, alias)) return source[alias];
    const lower = alias.toLowerCase();
    const matchedKey = keys.find((k) => String(k).toLowerCase() === lower);
    if (matchedKey) return source[matchedKey];
  }
  return '';
}

function normalizeSourceRow(row) {
  return {
    employeeName: String(pick(row, ['Employee', 'employee_name', 'employeeName']) || '').trim(),
    employeeId: String(pick(row, ['Employee ID', 'employee_id', 'employeeId', 'export_employee_id']) || '').trim(),
    departmentName: String(pick(row, ['Job Title', 'Department', 'job_title', 'department']) || '').trim(),
    departmentNumber: String(pick(row, ['Job Code', 'Department Number', 'job_code', 'department_number']) || '').trim(),
    rateAmount: String(pick(row, ['Hourly Rate', 'hourly_rate', 'hourlyRate', 'rate']) || '').trim(),
    regularHours: toNumber(pick(row, ['Regular Hours', 'regular_hours', 'regularHours', 'reg_hours'])),
    overtimeHours: toNumber(pick(row, ['Overtime Hours', 'overtime_hours', 'overtimeHours', 'ot_hours'])),
    doubleTimeHours: toNumber(pick(row, ['Double Time Hours', 'double_time_hours', 'doubleTimeHours', 'dt_hours'])),
  };
}

function buildWipRow(base, hours, earningCode) {
  return {
    ...base,
    earningCode,
    payHours: Number(hours.toFixed(2)),
  };
}

function getEarningCodeForType(setupAuditFields, type) {
  if (type === 'regular') return String(setupAuditFields['PR Reg Earning Code'] || '').trim();
  if (type === 'overtime') return String(setupAuditFields['PR Overtime Earning Code'] || '').trim();
  if (type === 'doubletime') return String(setupAuditFields['PR Double Time Earning Code'] || '').trim();
  return '';
}

function validationNoteForMissingCode(type) {
  if (type === 'regular') return 'Missing Regular Hours Earning Code. Fix in Airtable → Client Vitals → PR Reg Earning Code.';
  if (type === 'overtime') return 'Missing Overtime Hours Earning Code. Fix in Airtable → Client Vitals → PR Overtime Earning Code.';
  return 'Missing Double Time Hours Earning Code. Fix in Airtable → Client Vitals → PR Double Time Earning Code.';
}

function createAdpRunEarningsWipDataset({ rows = [], setupAuditFields = {}, periodStart, periodEnd }) {
  const iid = String(setupAuditFields['Payroll company code'] || '').trim();
  const periodStartDisplay = toMMDDYYYY(periodStart);
  const periodEndDisplay = toMMDDYYYY(periodEnd);

  const validRows = [];
  const validationRows = [];
  const excludedRows = [];

  const pushValidation = (row, note) => {
    validationRows.push({ ...row, wipNote: note });
  };

  const sourceRows = Array.isArray(rows) ? rows : [];
  sourceRows.forEach((sourceRow) => {
    const normalized = normalizeSourceRow(sourceRow);
    const base = {
      iid,
      payFrequency: 'B',
      payPeriodStart: periodStartDisplay,
      payPeriodEnd: periodEndDisplay,
      employeeName: normalized.employeeName,
      employeeId: normalized.employeeId,
      departmentName: normalized.departmentName,
      departmentNumber: normalized.departmentNumber,
      rateCode: 'BASE',
      rateAmount: normalized.rateAmount,
    };

    [
      ['regular', normalized.regularHours],
      ['overtime', normalized.overtimeHours],
      ['doubletime', normalized.doubleTimeHours],
    ].forEach(([type, hours]) => {
      if (hours < 0.005) {
        if (hours !== 0) {
          excludedRows.push({ ...base, earningCode: '', payHours: Number(hours.toFixed(2)), wipNote: 'Excluded from Earnings WIP: zero hours.' });
        }
        return;
      }

      const earningCode = getEarningCodeForType(setupAuditFields, type);
      const candidate = buildWipRow(base, hours, earningCode);

      if (!iid) return pushValidation(candidate, 'Missing Payroll Company Code / IID. Fix in Airtable → Client Vitals → Payroll company code.');
      if (!candidate.employeeId) return pushValidation(candidate, 'Missing Employee Id.');
      if (!candidate.departmentNumber) return pushValidation(candidate, 'Missing Department Number.');
      if (!candidate.rateAmount) return pushValidation(candidate, 'Missing Rate Amount.');
      if (!candidate.earningCode) return pushValidation(candidate, validationNoteForMissingCode(type));

      validRows.push(candidate);
    });
  });

  const grouped = new Map();
  validRows.forEach((row) => {
    const key = [row.employeeId, row.departmentNumber, row.earningCode, row.rateAmount].join('|||').toLowerCase();
    if (!grouped.has(key)) {
      grouped.set(key, { ...row });
      return;
    }
    const target = grouped.get(key);
    target.payHours = Number((toNumber(target.payHours) + toNumber(row.payHours)).toFixed(2));
  });

  const orderedValidRows = Array.from(grouped.values());
  return { headers: ADP_RUN_HEADERS, validRows: orderedValidRows, validationRows, excludedRows };
}

function rowToCells(row) {
  return [
    row.iid || '',
    'B',
    row.payPeriodStart || '',
    row.payPeriodEnd || '',
    row.employeeName || '',
    row.employeeId || '',
    row.earningCode || '',
    row.payHours === 0 || row.payHours ? row.payHours : '',
    '',
    0,
    row.departmentName || '',
    row.departmentNumber || '',
    'BASE',
    row.rateAmount || '',
  ];
}

async function buildAdpRunEarningsWipWorkbookBuffer({ rows = [], setupAuditFields = {}, periodStart, periodEnd }) {
  if (!ExcelJS) throw new Error('exceljs_required_for_earnings_wip_export');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Earnings WIP');
  const dataset = createAdpRunEarningsWipDataset({ rows, setupAuditFields, periodStart, periodEnd });

  sheet.getCell('A1').value = '##GENERIC## V2.0';
  sheet.addRow(dataset.headers);
  dataset.validRows.forEach((row) => sheet.addRow(rowToCells(row)));

  if (dataset.validationRows.length) {
    sheet.addRow([]); sheet.addRow([]); sheet.addRow([]);
    sheet.addRow([...dataset.headers, 'WIP NOTE']);
    dataset.validationRows.forEach((row) => sheet.addRow([...rowToCells(row), row.wipNote || '']));
  }

  if (dataset.excludedRows.length) {
    sheet.addRow([]); sheet.addRow([]); sheet.addRow([]);
    sheet.addRow([...dataset.headers, 'WIP NOTE']);
    dataset.excludedRows.forEach((row) => sheet.addRow([...rowToCells(row), row.wipNote || '']));
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function buildAdpRunEarningsWipFilename(locationName, periodStart, periodEnd) {
  const safeLocation = sanitizeFilenamePart(locationName || 'Location');
  const start = toMMDDYYYY(periodStart).replace(/\//g, '-');
  const end = toMMDDYYYY(periodEnd).replace(/\//g, '-');
  return `${safeLocation} Earnings WIP ${start} to ${end}.xlsx`;
}

module.exports = {
  ADP_RUN_HEADERS,
  createAdpRunEarningsWipDataset,
  buildAdpRunEarningsWipWorkbookBuffer,
  buildAdpRunEarningsWipFilename,
};
