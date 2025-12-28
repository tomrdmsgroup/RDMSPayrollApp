// server/src/domain/artifactBuilders/wipReportBuilder.js
//
// Step 6 builder (no I/O):
// Produces lightweight structured content to attach to the Outcome.
// Real provider-specific pulls and file formatting happen later.

function nowIso() {
  return new Date().toISOString();
}

/**
 * buildWipReport({ run, policySnapshot })
 *
 * Returns:
 * { status: "generated"|"skipped"|"failed", content }
 */
function buildWipReport({ run, policySnapshot }) {
  const payrollCompany = policySnapshot?.payroll_company;

  // WIP only applies to certain payroll providers
  const wipRequired =
    policySnapshot?.wip_required === true ||
    payrollCompany === 'ADP_WFN' ||
    payrollCompany === 'ADP_RUN';

  if (!wipRequired) {
    return { status: 'skipped', content: null };
  }

  // Step 6 placeholder content
  const content = {
    format: 'structured',
    generated_at: nowIso(),
    run_id: Number(run?.id),
    payroll_company: payrollCompany || null,
    rows: [],
  };

  return { status: 'generated', content };
}

module.exports = {
  buildWipReport,
};
