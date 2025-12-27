# CODEX_AUDIT_LOCK (NON-AUTHORITATIVE MARKER)

This file is NOT a spec and must NOT introduce requirements.
It only marks “do not widen scope / do not refactor boundaries” unless CODEX_ENTRYPOINT.md and CODEX_BUILD_CONTRACT.md are updated.


## 0) CLOSED WORLD + AUTHORITY
- The authoritative system contract is the Payroll App Binder.
- V1.2.1 is the current contract layer.
- Codex MUST NOT infer, assume, or invent behavior, UI flows, exports, or logic outside what is explicitly defined by the binder and explicitly stated in this repo.

## 1) SCOPE LOCK (WHAT CODEX IS ALLOWED TO DO)
Codex is allowed to:
- Implement the system exactly as defined in the binder layers (V1.0 + V1.1 + V1.2 + V1.2.1).
- Add missing pieces ONLY when they are explicitly required by the binder and the repository files already establish the intended module boundaries.
- Keep implementations minimal and auditable.
- Treat Airtable as read-only authority (even if stubbed now).
- Treat Toast as the sole payroll calculation authority (no recomputation or normalization).
- Preserve and extend existing module boundaries under `server/src/domain/` and `server/src/api/`.

Codex is NOT allowed to:
- Add new “helpful” workflows.
- Invent UI pages, user journeys, or navigation beyond the binder-defined ops console surfaces.
- Reorder architectural layers or collapse providers/services together.
- Add “demo rules” or “example behaviors” unless explicitly requested in writing.
- Change file/route semantics without explicit instruction.

## 2) NON-NEGOTIABLE DOMAIN CONSTRAINTS
- Findings are produced by `server/src/domain/validationEngine.js` in a stable contract:
  - Finding fields: `code`, `message`, `details`, `severity`, `status`, `emit_asana_alert`.
- System failures (provider/auth/api/email/buttons/rendering/etc.) are NOT findings.
  - System failures must go through `failureService` and the failure protocol.
- Asana tasks are INTERNAL ONLY.
  - Findings-triggered Asana tasks happen ONLY when `finding.emit_asana_alert === true`.
  - Do not use `status` or `severity` as a proxy for Asana task creation.

## 3) EXCLUSIONS MUST BE DECIDED ONCE AND CONSUMED EVERYWHERE
- “Excluded employees” are app-owned config, per client/location.
- Exclusions are scoped per surface:
  - validation findings
  - payroll export (WIP)
  - tip report
- Exclusion decisions are made ONCE per run (location + period) and then reused by all downstream surfaces.
- Codex MUST NOT re-implement “is excluded?” logic separately in validation vs exports vs tips.
- Even when exclusions are stubbed, calls into validation MUST explicitly pass `exclusions` (e.g. `exclusions: []`) to freeze the contract.

## 4) EXPORTS / ARTIFACTS ARE CONTRACTS
- WIP and Tips outputs are contracts, not “nice-to-have.”
- File types: XLSX
- File naming (exact):
  - Tips: "[Location Name] Tips report PPE [DD.MM.YY].xlsx"
  - WIP:  "[Location Name] WIP PPE [DD.MM.YY].xlsx"
- "PPE" means pay period ending date = `period_end`.
- Date format: DD.MM.YY (two-digit year).
- Required headers and column order must remain unchanged once defined.
- Exclusions must be applied BEFORE writing rows:
  - excluded from WIP => no row in WIP
  - excluded from Tips => no row in Tips
  - excluded from Audit => employee is not evaluated by validation rules

## 5) MANUAL ACTIONS MUST EXIST WITHOUT EMAIL
- The system must support generating outcomes WITHOUT sending email:
  - Run Audit (no email)
  - Generate WIP (no email)
  - Generate Tips (no email)
- Email send/resend is a separate action and must not be required to view outcomes.

## 6) AUTH + AUDIT LOGGING (V1.2+)
- Users authenticate with email + password.
- Two roles: Admin, User.
- Admin manages accounts (create/disable/reset password).
- Any change to app-owned config or manual actions must be audit-logged:
  - who (user email)
  - when
  - what changed
  - which client/location/period

## 7) PROVIDER WIRING DISCIPLINE (ORDER MATTERS)
- Provider stubs must not be collapsed prematurely.
- Implement providers in order:
  1) Toast
  2) Airtable read-only
  3) Email + tokens
  4) Asana
- For Toast bring-up, temporary test credentials/config may be used.
- Airtable remains stubbed until Airtable step is explicitly started.

## 8) UI CONSTRAINTS (NO INVENTION)
Codex may implement only binder-supported internal ops console surfaces:
- Select client/location
- Select payroll period (from calendar)
- Manage:
  - rule enablement/params
  - excluded employees (scoped flags)
- Manual actions:
  - run validation
  - generate exports
  - generate tip report
  - send/resend email (with guardrails)
  - reissue tokens (with guardrails)

Codex must not create additional UI pages/flows outside these surfaces.

## 9) CHANGE DISCIPLINE
- Avoid churn.
- Do not repeatedly rewrite the same file in fragments.
- If a change requires multiple files, provide cohesive full replacements together.
- Do not add unused imports.
- Do not claim tests were run unless explicitly run and the command is stated.

END.
