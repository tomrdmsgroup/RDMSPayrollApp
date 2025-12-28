// server/src/domain/artifactBuilders/tipsReportBuilder.js
//
// Step 6 builder (no I/O):
// Produces lightweight structured content to attach to the Outcome.
// Real provider-specific pulls and file formatting happen later.

function nowIso() {
  return new Date().toISOString();
}

/**
 * buildTipsReport({ run, policySnapshot })
 *
 * Returns:
 * { status: "generated"|"skipped"|"failed", content }
 */
function buildTipsReport({ run, policySnapshot }) {
  // If policy says tips are not required, skip.
  const tipsRequired =
    policySnapshot?.tip_report_required === true ||
    (policySnapshot?.tip_report_type && policySnapshot.tip_report_type !== 'NONE');

  if (!tipsRequired) {
    return { status: 'skipped', content: null };
  }

  // Step 6 content: a structured placeholder, not a file.
  // Later steps will replace rows with real pulled data and generate a file.
  const content = {
    format: 'structured',
    generated_at: nowIso(),
    run_id: Number(run?.id),
    tip_report_type: policySnapshot?.tip_report_type || null,
    rows: [],
  };

  return { status: 'generated', content };
}

module.exports = {
  buildTipsReport,
};
