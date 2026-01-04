// server/src/routes/opsRoutes.js
//
// Export: opsRouter(req, res, url)

const { createRun, appendEvent, updateRun, getRunById } = require('../domain/runManager');
const { buildOutcome, saveOutcome, getOutcome, updateOutcome } = require('../domain/outcomeService');
const { composeEmail } = require('../domain/emailComposer');
const { sendOutcomeEmail } = require('../domain/emailService');
const { buildArtifacts } = require('../domain/artifactService');

const { requireOpsToken } = require('../domain/opsAuth');
const { fetchVitalsSchema, fetchVitalsSnapshot } = require('../providers/vitalsProvider');
const {
  fetchToastTimeEntriesFromVitals,
  fetchToastAnalyticsJobsFromVitals,
} = require('../providers/toastProvider');

const AIRTABLE_FROM_FIELD = 'PR RDMS Payroll Project Email Address';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function nowIso() {
  return new Date().toISOString();
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) resolve(null);
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
  });
}

function readQuery(url) {
  const q = {};
  for (const [k, v] of url.searchParams.entries()) q[k] = v;
  return q;
}

function enforceOpsToken(req, res, url) {
  const r = requireOpsToken(req, res, url);
  return !!(r && r.ok);
}

function safeStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function getFromAddressFromVitalsRecord(vitalsRecord) {
  if (!vitalsRecord || typeof vitalsRecord !== 'object') return '';
  return safeStr(vitalsRecord[AIRTABLE_FROM_FIELD]);
}

async function lookupFromAddressForLocation(client_location_id) {
  const snapshot = await fetchVitalsSnapshot(client_location_id);
  const record = (snapshot && snapshot.data && snapshot.data[0]) || null;
  const from = getFromAddressFromVitalsRecord(record);
  return { snapshot, record, from };
}

async function handleStatus(req, res) {
  return json(res, 200, { ok: true });
}

/**
 * Airtable
 */
async function handleAirtableSchema(req, res, url) {
  if (!enforceOpsToken(req, res, url)) return;
  try {
    const schema = await fetchVitalsSchema();
    return json(res, 200, { ok: true, schema });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || 'airtable_schema_failed' });
  }
}

async function handleAirtableVitals(req, res, url) {
  if (!enforceOpsToken(req, res, url)) return;

  const q = readQuery(url);
  if (!q.client_location_id) {
    return json(res, 400, { ok: false, error: 'missing_required_fields' });
  }

  try {
    const snapshot = await fetchVitalsSnapshot(q.client_location_id);
    return json(res, 200, { ok: true, snapshot });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || 'airtable_vitals_failed' });
  }
}

/**
 * Core ops
 */
async function handleRun(req, res, url) {
  if (!enforceOpsToken(req, res, url)) return;

  const body = await parseBody(req);
  if (body === null) return json(res, 400, { ok: false, error: 'invalid_json' });

  const { client_location_id, period_start, period_end, policy_snapshot = null } = body;

  if (!client_location_id || !period_start || !period_end) {
    return json(res, 400, { ok: false, error: 'missing_required_fields' });
  }

  let policySnapshot = policy_snapshot;

  if (policySnapshot?.delivery?.mode === 'email') {
    try {
      const { from } = await lookupFromAddressForLocation(client_location_id);
      if (safeStr(from)) {
        policySnapshot = {
          ...policySnapshot,
          delivery: {
            ...policySnapshot.delivery,
            from: from.trim(),
            reply_to: from.trim(),
          },
        };
      }
    } catch {}
  }

  const run = await createRun({
    client_location_id,
    period_start,
    period_end,
    payload: { policy_snapshot: policySnapshot },
    status: 'running',
  });

  appendEvent(run, 'ops_run_created', {});
  await updateRun(run.id, { events: run.events });

  const artifacts = buildArtifacts({ run, policySnapshot: policySnapshot || {} });
  const outcome = await buildOutcome(run, [], artifacts, policySnapshot);
  const savedOutcome = await saveOutcome(run.id, outcome);

  appendEvent(run, 'ops_outcome_saved', { outcome_status: savedOutcome.status });
  await updateRun(run.id, { status: 'completed', events: run.events });

  run.status = 'completed';
  run.updated_at = nowIso();

  return json(res, 200, { ok: true, run, outcome: savedOutcome });
}

async function handleInspect(req, res, url, runId) {
  if (!enforceOpsToken(req, res, url)) return;

  const run = await getRunById(runId);
  if (!run) return json(res, 404, { ok: false, error: 'run_not_found' });

  const outcome = await getOutcome(runId);
  return json(res, 200, { ok: true, run, outcome });
}

async function handleSendEmail(req, res, url, runId) {
  if (!enforceOpsToken(req, res, url)) return;

  const run = await getRunById(runId);
  let outcome = await getOutcome(runId);

  if (!run || !outcome) {
    return json(res, 404, { ok: false, error: 'run_or_outcome_not_found' });
  }

  if (outcome.delivery?.mode !== 'email') {
    return json(res, 400, { ok: false, error: 'delivery_mode_not_email' });
  }

  if (!outcome.delivery.subject) {
    const rendered = composeEmail(outcome, run);
    outcome = await updateOutcome(runId, {
      delivery: {
        subject: rendered.subject,
        rendered_text: rendered.text,
        rendered_html: rendered.html,
      },
    });
  }

  const sendResult = await sendOutcomeEmail(outcome);

  if (sendResult?.ok) {
    outcome = await updateOutcome(runId, {
      status: 'delivered',
      delivery: {
        sent_at: nowIso(),
        provider_message_id: sendResult.providerMessageId || null,
      },
    });

    appendEvent(run, 'ops_email_sent', { provider_message_id: sendResult.providerMessageId });
    await updateRun(run.id, { events: run.events });

    return json(res, 200, { ok: true, message_id: sendResult.providerMessageId });
  }

  return json(res, 500, { ok: false, error: 'email_send_failed' });
}

async function opsRouter(req, res, url) {
  const pathname = url.pathname || '';

  if (pathname === '/ops/status' && req.method === 'GET') return handleStatus(req, res);
  if (pathname === '/ops/airtable/schema' && req.method === 'GET') return handleAirtableSchema(req, res, url);
  if (pathname === '/ops/airtable/vitals' && req.method === 'GET') return handleAirtableVitals(req, res, url);
  if (pathname === '/ops/run' && req.method === 'POST') return handleRun(req, res, url);

  const inspectMatch = pathname.match(/^\/ops\/run\/(\d+)$/);
  if (inspectMatch && req.method === 'GET') return handleInspect(req, res, url, inspectMatch[1]);

  const sendMatch = pathname.match(/^\/ops\/send-email\/(\d+)$/);
  if (sendMatch && req.method === 'POST') return handleSendEmail(req, res, url, sendMatch[1]);

  return json(res, 404, { ok: false, error: 'not_found' });
}

module.exports = { opsRouter };
