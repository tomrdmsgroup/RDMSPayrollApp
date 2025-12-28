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
    const status = (f?.status || '').toString().toLowerCase().trim();
    if (!status) continue;

    counts.total += 1;

    if (status === 'success') counts.success += 1;
    else if (status === 'warning') counts.warning += 1;
    else if (status === 'failure') counts.failure += 1;
    else if (status === 'error') counts.error += 1;
    else counts.total += 0; // ignore unknown statuses beyond total
  }

  return counts;
}

function needsAttentionFromFindings(findings) {
  for (const f of findings) {
    const status = (f?.status || '').toString().toLowerCase().trim();
    if (status === 'failure' || status === 'error') return true;
  }
  return false;
}

function buildActions(runId) {
  const approve = createToken({ run_id: runId, type: 'approval' });
  const rerun = createToken({ run_id: runId, type: 'rerun' });

  return {
    approve_url: approve ? `/approve?token=${approve.token}` : null,
    rerun_url: rerun ? `/rerun?token=${rerun.token}` : null,
  };
}

function buildOutcome(run, findings, artifacts, policySnapshot) {
  const safeFindings = normalizeFindings(findings);
  const counts = computeFindingCounts(safeFindings);
  const needsAttention = needsAttentionFromFindings(safeFindings);

  const status = needsAttention ? 'needs_attention' : 'completed';

  const outcome = {
    run_id: Number(run?.id),
    version: 1,
    created_at: nowIso(),
    updated_at: nowIso(),

    status,

    summary: {
      finding_counts: counts,
      needs_attention: needsAttention,
    },

    findings: safeFindings,
    artifacts: Array.isArray(artifacts) ? artifacts : [],

    delivery: {
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
    },

    actions: buildActions(Number(run?.id)),

    policy_snapshot: policySnapshot || null,
  };

  return outcome;
}

function saveOutcome(runId, outcome) {
  if (!runId || !outcome) return null;

  const id = Number(runId);
  let saved = null;

  updateStore((store) => {
    if (!Array.isArray(store.outcomes)) store.outcomes = [];

    const idx = store.outcomes.findIndex((o) => Number(o.run_id) === id);
    const now = nowIso();

    if (idx >= 0) {
      const merged = {
        ...store.outcomes[idx],
        ...outcome,
        run_id: id,
        updated_at: now,
      };

      if (!merged.created_at) merged.created_at = now;

      store.outcomes[idx] = merged;
      saved = merged;
      return store;
    }

    const toInsert = {
      ...outcome,
      run_id: id,
      created_at: outcome.created_at || now,
      updated_at: now,
    };

    store.outcomes.push(toInsert);
    saved = toInsert;
    return store;
  });

  return saved;
}

function getOutcome(runId) {
  if (!runId) return null;

  const id = Number(runId);
  let found = null;

  updateStore((store) => {
    found = Array.isArray(store.outcomes)
      ? store.outcomes.find((o) => Number(o.run_id) === id) || null
      : null;
    return store;
  });

  return found;
}

function updateOutcome(runId, patch) {
  if (!runId || !patch) return null;

  const id = Number(runId);
  let updated = null;

  updateStore((store) => {
    if (!Array.isArray(store.outcomes)) store.outcomes = [];

    const idx = store.outcomes.findIndex((o) => Number(o.run_id) === id);
    if (idx < 0) {
      updated = null;
      return store;
    }

    const now = nowIso();
    const merged = {
      ...store.outcomes[idx],
      ...patch,
      run_id: id,
      updated_at: now,
    };

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
