// server/src/domain/artifactService.js
//
// Artifact service
// - decides which artifacts apply based on policy
// - invokes builders
// - normalizes artifact records
// - never throws (artifact failures do not fail runs)

const { notifyFailure } = require('./failureService');
const { buildTipsReport } = require('./artifactBuilders/tipsReportBuilder');
const { buildWipReport } = require('./artifactBuilders/wipReportBuilder');

function nowIso() {
  return new Date().toISOString();
}

function baseArtifact({ type, label, builder, required }) {
  return {
    type,
    label,
    builder,
    version: 1,
    generated_at: nowIso(),
    required: !!required,
    status: 'skipped',
    content: null,
  };
}

/**
 * Determine which artifacts apply for this run based on policy snapshot.
 * Policy shape is assumed to be resolved upstream (Airtable snapshot).
 */
function determineArtifactPlan(policySnapshot = {}) {
  const plan = [];

  // Tips report
  const tipsRequired =
    policySnapshot?.tip_report_required === true ||
    policySnapshot?.tip_report_type && policySnapshot.tip_report_type !== 'NONE';

  plan.push({
    type: 'tips_report',
    label: 'Tips Report',
    builder: 'tipsReportBuilder',
    required: !!tipsRequired,
  });

  // WIP report
  const wipRequired =
    policySnapshot?.wip_required === true ||
    policySnapshot?.payroll_company === 'ADP_WFN' ||
    policySnapshot?.payroll_company === 'ADP_RUN';

  plan.push({
    type: 'wip_report',
    label: 'Work In Progress Report',
    builder: 'wipReportBuilder',
    required: !!wipRequired,
  });

  return plan;
}

/**
 * Execute a single artifact builder safely.
 */
function executeBuilder({ type, run, policySnapshot }) {
  try {
    if (type === 'tips_report') {
      return buildTipsReport({ run, policySnapshot });
    }

    if (type === 'wip_report') {
      return buildWipReport({ run, policySnapshot });
    }

    return { status: 'skipped', content: null };
  } catch (err) {
    notifyFailure({
      step: 'artifact_builder',
      artifact_type: type,
      runId: run?.id,
      error: err?.message || 'artifact_builder_failed',
    });

    return { status: 'failed', content: null };
  }
}

/**
 * buildArtifacts({ run, policySnapshot })
 *
 * Returns an array of normalized artifact records.
 */
function buildArtifacts({ run, policySnapshot }) {
  const plan = determineArtifactPlan(policySnapshot);
  const artifacts = [];

  for (const item of plan) {
    const artifact = baseArtifact(item);

    if (!item.required) {
      artifact.status = 'skipped';
      artifacts.push(artifact);
      continue;
    }

    const result = executeBuilder({
      type: item.type,
      run,
      policySnapshot,
    });

    artifact.status = result?.status || 'failed';
    artifact.content = result?.content || null;

    artifacts.push(artifact);
  }

  return artifacts;
}

module.exports = {
  buildArtifacts,
};
