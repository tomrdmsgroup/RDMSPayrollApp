// server/src/domain/outcomeService.js

const { updateStore } = require('./persistenceStore');
const { createToken } = require('./tokenService');

function nowIso() {
  return new Date().toISOString();
}

function normalizeFindings(findings) {
  return Array.isArray(findings) ? findings : [];
}

function computeFindingCounts(findings) {
  const counts = {
    total: 0,
    success: 0,
    warning: 0,
    failure: 0,
    error: 0,
  };

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

function buildActions(runId) {
  const approve = createToken({ run_id: runId, type: 'approval' });
  const rerun = createToken({ run_id: runId, type: 'rerun' });

  return {
    approve_url: approve ? `/approve?token=${approve.token}` : null,
    rerun_url: rerun ? `/rerun?token=${rerun.token}` : null,
  };
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

function buildOutcome(run, findings, artifacts, policySnapshot) {
  const safeFindings = normalizeFindings(findings);
  const counts = computeFindingCounts(safeFindings);
  const needsAttention = needsAttentionFromFindings(safeFindings);

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

    delivery: defaultDelivery(),

    actions: buildActions(run.id),

    policy_snapshot: policySnapshot || null,
  };
}

function saveOutcome(runId, outcome) {
  let saved = null;

  updateStore((store) => {
    if (!Array.isArray(store.outcomes)) store.outcomes = [];

    const idx = store.outcomes.findIndex((o) => o.run_id === runId);
    const now = nowIso();

    if (idx >= 0) {
      const merged = {
        ...store.outcomes[idx],
        ...outcome,
        run_id: runId,
        updated_at: now,
      };

      merged.delivery = normalizeDelivery(merged.delivery);

      store.outcomes[idx] = merged;
      saved = merged;
      return store;
    }

    const inserted = {
      ...outcome,
      run_id: runId,
      created_at: now,
      updated_at: now,
    };

    inserted.delivery = normalizeDelivery(inserted.delivery);

    store.outcomes.push(inserted);
    saved = inserted;
    return store;
  });

  return saved;
}

function getOutcome(runId) {
  let found = null;

  updateStore((store) => {
    found = store.outcomes.find((o) => o.run_id === runId) || null;
    return store;
  });

  if (found) found.delivery = normalizeDelivery(found.delivery);
  return found;
}

function updateOutcome(runId, patch) {
  let updated = null;

  updateStore((store) => {
    const idx = store.outcomes.findIndex((o) => o.run_id === runId);
    if (idx < 0) return store;

    const existing = store.outcomes[idx];
    const now = nowIso();

    let status = existing.status;
    if (patch.delivery?.sent_at) status = 'delivered';

    const merged = {
      ...existing,
      ...patch,
      status,
      updated_at: now,
    };

    merged.delivery = normalizeDelivery({
      ...existing.delivery,
      ...patch.delivery,
    });

    store.outcomes[idx] = merged;
    updated = merged;
    return store;
  });

  return updated;
}

module.exports = {
  buildOutcome,
  saveOutcome,
  getOutcome,
  updateOutcome,
  computeFindingCounts,
  needsAttentionFromFindings,
};
