// server/src/domain/validationEngine.js
// Validation Findings Layer (foundation).
// - Produces Findings in a stable contract for UI / export / Asana consumers.
// - System failures (API down/auth/etc.) are NOT findings; they go through failureService.

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

// Demo behavior: returns one finding only when context.demo === true
async function runValidation({ run, context, exclusions = [], ruleCatalog = getRuleCatalog() }) {
  const findings = [];

  return {
    run_id: run?.id || null,
    findings,
  };
}

module.exports = { runValidation, makeFinding, getRuleCatalog };
