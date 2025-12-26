# CODEX BUILD CONTRACT (RDMSPayrollApp)

NON-NEGOTIABLE WORKFLOW
- Output must be Outcome → Next step(s) only. No padding.
- When you say “full replacement”, provide a FULL file replacement (including module.exports / exports).
- Complete Step N fully before Step N+1.
- Avoid churn: if a change touches multiple files, list the exact file replacements in one pass.
- Do not claim tests were run.

CORE RULES
- Closed world: do not invent behavior not in binder.
- Findings are not system failures; system failures go to failureService.
- Asana tasks for findings only when finding.emit_asana_alert === true.
- Exclusion decisions computed once per run, reused across validation/WIP/tips.

STEP 3 (NEXT CODEx STEP) — EXPORTS (NO EMAIL)
- Implement XLSX generation for:
  - WIP report: "[Location Name] WIP PPE [DD.MM.YY].xlsx"
  - Tips report: "[Location Name] Tips report PPE [DD.MM.YY].xlsx"
- Apply exclusion decisions BEFORE writing rows:
  - excluded for WIP → no row in WIP
  - excluded for Tips → no row in Tips
- Do NOT wire Airtable yet.
- Do NOT introduce email sending yet.
