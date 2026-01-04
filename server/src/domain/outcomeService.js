// server/src/domain/outcomeService.js

const { query } = require('./db');
const { createToken } = require('./tokenService');

function nowIso() {
  return new Date().toISOString();
}

function normalizeFindings(findings) {
  return Array.isArray(findings) ? findings : [];
}

function computeFindingCounts(findings) {
  const counts = { total: 0, success: 0, warning: 0, failure: 0, error: 0 };
  for (const f of findings) {
    const status = (f?.status || '').toLowerCase();
    if (!status) continue;
    counts.total += 1;
    if (status === 'success') counts.success += 1;
    else if (status === 'warning') counts.warning += 1;
    else if (status === 'failure') counts.failure += 1;
    else if (status === 'error') counts.error += 1;
  }
  return counts;
}

function needsAttentionFromFindings(findings) {
  return findings.some((f) => {
    const s = (f?.status || '').toLowerCase();
    return s === 'failure' || s === 'error';
  });
}

function defaultDelivery() {
  return {
    mode: 'internal_only',
    scheduled_send_at: null,
    sent_at: null,
    provider_message_id: null,
    recipients: [],
    from: null,
    reply_to: null,
    subject: null,
    rendered_html: null,
    rendered_text: null,
  };
}

function normalizeDelivery(delivery) {
  const base = defaultDelivery();
  if (!delivery || typeof delivery !== 'object') return base;
  return {
    ...base,
    ...delivery,
    recipients: Array.isArray(delivery.recipients) ? delivery.recipients : base.recipients,
  };
}

async function buildActions(runId) {
  const approve = await createToken({ run_id: runId, type: 'approval' });
  const rerun = await createToken({ run_id: runId, type: 'rerun' });

  return {
    approve_url: approve ? `/approve?token=${approve.token}` : null,
    rerun_url: rerun ? `/rerun?token=${rerun.token}` : null,
  };
}

async function buildOutcome(run, findings, artifacts, policySnapshot) {
  const safeFindings = normalizeFindings(findings);
  const counts = computeFindingCounts(safeFindings);
  const needsAttention = needsAttentionFromFindings(safeFindings);

  const deliveryFromPolicy =
    policySnapshot && typeof policySnapshot === 'object' ? policySnapshot.delivery : null;

  return {
    run_id: Number(run.id),
    version: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
    status: needsAttention ? 'needs_attention' : 'completed',
    summary: {
      finding_counts: counts,
      needs_attention: needsAttention,
    },
    findings: safeFindings,
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    delivery: normalizeDelivery(deliveryFromPolicy),
    actions: await buildActions(run.id),
    policy_snapshot: policySnapshot || null,
  };
}

async function saveOutcome(runId, outcome) {
  const id = Number(runId);
  if (!id) return null;

  const normalized = { ...(outcome || {}), run_id: id };
  normalized.delivery = normalizeDelivery(normalized.delivery);

  await query(
    `
    INSERT INTO ops_outcomes (run_id, outcome, created_at, updated_at)
    VALUES ($1, $2::jsonb, NOW(), NOW())
    ON CONFLICT (run_id)
    DO UPDATE SET outcome = EXCLUDED.outcome, updated_at = NOW()
    `,
    [id, normalized],
  );

  return getOutcome(id);
}

async function getOutcome(runId) {
  const id = Number(runId);
  if (!id) return null;

  const r = await query(`SELECT outcome FROM ops_outcomes WHERE run_id = $1`, [id]);
  if (!r.rows.length) return null;

  const found = r.rows[0].outcome || null;
  if (found) found.delivery = normalizeDelivery(found.delivery);
  return found;
}

async function updateOutcome(runId, patch) {
  const id = Number(runId);
  if (!id) return null;

  const existing = await getOutcome(id);
  if (!existing) return null;

  let status = existing.status;
  if (patch?.delivery?.sent_at) status = 'delivered';

  const merged = {
    ...existing,
    ...patch,
    status,
    updated_at: nowIso(),
  };

  merged.delivery = normalizeDelivery({
    ...existing.delivery,
    ...(patch?.delivery || {}),
  });

  await query(`UPDATE ops_outcomes SET outcome = $1::jsonb, updated_at = NOW() WHERE run_id = $2`, [
    merged,
    id,
  ]);

  return merged;
}

module.exports = {
  buildOutcome,
  saveOutcome,
  getOutcome,
  updateOutcome,
};
