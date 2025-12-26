# CODEX_ENTRYPOINT (AUTHORITATIVE FOR CODEX EXECUTION)

## 1) Binder loading (contract layers, not build phases)
These binders are ALL active simultaneously:

- Payroll App Binder — V1.0  (base system contract)
- Payroll App Binder — V1.1  (additive ops console + observability; V1.0 guardrails win on conflict)
- Payroll App Binder — V1.2  (auth + roles + audit logging tied to identity)
- Payroll App Binder — V1.2.1 (tightening of V1.2 only; does NOT replace V1.0 or V1.1)

Rule:
- V1.2.1 refines V1.2.
- V1.1 adds capabilities but cannot violate V1.0 boundaries.
- Nothing replaces V1.0.

## 2) Closed-world rule
Anything not explicitly stated in the binders does not exist.
Do not infer workflows, UI, computations, or failure behaviors.

## 3) Repo contracts that must not be reinterpreted
### Findings contract
server/src/domain/validationEngine.js produces Findings with EXACT keys:
- code
- message
- details
- severity
- status
- emit_asana_alert

System failures are NOT findings and go through failureService.

### Asana findings gating
server/src/domain/asanaTaskService.js must only create tasks when:
- finding.emit_asana_alert === true

### Exclusions
Excluded employees are app-owned config, effective-dated, and scoped to:
- validation findings
- payroll export
- tip report

Exclusions remove employees from the scoped outputs; they do not alter Toast authority.

## 4) Current “Codex phase” objective (pre-provider wiring)
Objective is to make GitHub structure + boundaries bulletproof so future provider wiring follows binder order:
1) Toast provider
2) Airtable read-only provider
3) Email + tokens
4) Asana

Do not collapse stubs early.

## 5) Allowed changes in this phase
- Add/adjust documentation that clarifies binder loading + frozen contracts (this file).
- Fix obvious contract violations (e.g., Asana gating by status instead of emit_asana_alert).
- Do NOT invent new features, UI flows, or provider logic not in binder.

## 6) Disallowed changes in this phase
- Do not introduce new “replacement binder” assumptions.
- Do not add parallel engines or duplicate contract sources.
- Do not refactor routes.js repeatedly; only change it when the step requires it and provide full-file replacements.

