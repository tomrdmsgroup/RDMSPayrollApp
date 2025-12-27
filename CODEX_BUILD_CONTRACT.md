Work in repo RDMSPayrollApp. Follow the BUILD CONTRACT exactly (pasted below). Implement Step 1 only. Do not touch anything outside Step 1. Provide a single PR with cohesive full-file replacements, no incremental churn.

STEP 1 GOAL (Config surfaces foundation, no Airtable wiring yet):
1) Add persistence-backed models/services for:
   - client_locations (seedable, read/write)
   - rule_configs (per location, enabled + params)
   - exclusions (per location + employee, effective dates, scope flags)
2) Implement a single “Excluded Employee Decisions” function that, for a given run (location + period), returns per-employee decisions:
   - audit: include/exclude
   - wip: include/exclude
   - tips: include/exclude
   This must be computed ONCE and reused. Do not duplicate exclusion logic in multiple modules.
3) Wire decisions into validationEngine ONLY (for now):
   - validationEngine.runValidation must accept exclusions input (already does) and must be able to exclude employees from audit based on scope flags.
   - Do not change WIP/tips generation yet, but design the decision output so those modules can consume it later without redefining logic.
4) Do NOT change UI yet. Do NOT wire Airtable yet. Use stubs/seed data.
5) Do NOT add “demo rules”.
6) Do NOT change routes.js except if required to preserve the runValidation contract or to add a new endpoint specifically for managing exclusions/rule_configs/client_locations.
7) Add minimal CRUD endpoints (server/api) for:
   - GET locations (alphabetized)
   - GET/PUT rule configs for a location
   - GET/POST/PUT/DELETE exclusions for a location
   Keep auth stubbed.

Acceptance checks:
- Exclusions table supports per-surface toggles via scope_flags (audit/wip/tips) and effective dates.
- There is exactly one module that computes exclusion decisions for a run, and validationEngine consumes its audit decision.
- All changes compile; if tests are added, include exact commands; otherwise state “no tests added”.

THE BUILD CONTRACT


You are working in the repo RDMSPayrollApp (Node backend + web frontend). Follow this contract exactly.

NON-NEGOTIABLE WORKFLOW
- Output must be Outcome → Next step(s) only. No “why this matters”, no reassurance, no padding.
- If you cannot give explicit click-by-click instructions for UI actions, ask for a screenshot first.
- When you say “full replacement”, provide a FULL file replacement (including module.exports / exports).
- Do not introduce new “surfaces to wire” out of order. Complete Step N fully before Step N+1.
- Avoid churn: if a change touches multiple files, list the exact file replacements in one pass.
- Prefer small PRs, but each PR must be complete for its step.
- Do not claim tests were run. If you add a test script, specify exactly how to run it and confirm it was run (or explicitly say it was not run).

CORE DOMAIN MODEL (HIGH LEVEL)
This app generates payroll validation outcomes and exports.
- Validation rules produce FINDINGS.
- System failures (API down/auth/etc.) are NOT findings; they go through failureService.
- Asana tasks are INTERNAL only (for the client’s specified payroll project), not client-facing.
- Rule behavior must be configurable per client/location:
  - Each rule can be enabled/disabled per client/location.
  - Each rule can control whether it creates an Asana task (emit_asana_alert true/false).
- “Excluded Staff” is its own surface in the app (not buried in the same screen as rule configs).
- Exclusions can be configured per employee and can be toggled per location for each surface:
  - Include/exclude for: (1) WIP export, (2) Tips report/sheet, (3) Validation/Audit findings.
  - If excluded for a surface, that employee is omitted from that surface entirely.
  - This must be driven by client/location config (not hardcoded).
- Exclusion decisions are made ONCE per run (per location + period), and every downstream surface consumes those decisions.
  - Do not re-implement “is excluded?” logic separately inside exports, tips, and validation.

DATA SOURCES (Airtable is authoritative later)
- Airtable “Vitals” will be the upstream source for:
  - list of locations (client_locations)
  - PR Validation APP Active? = YES/NO (if NO, do not show location in the app dropdown)
  - payroll calendar reference (read-only in app)
  - PR Validation Send Time (time-of-day to send the report after pay period ends)
  - payroll provider (ADP Run / ADP WFN / Paychex), tip report type, contacts, reply-to, etc. (future wiring)
  - Asana project/section IDs (future wiring)
- Airtable read-only provider may exist later; for now stub as needed but keep the contract stable.

TIME / CALENDAR RULE (MUST BE SUPPORTED)
- Pay period boundaries (period_start, period_end) come from the Payroll Calendar (Airtable).
- “PR Validation Send Time” is a per-location time-of-day setting in Airtable.
- The scheduled send moment is derived as:
  - target_send_datetime = (period_end + 1 day) at PR Validation Send Time in the location timezone
  - timezone source: client_locations.timezone (or Airtable timezone field)
- The system must support:
  1) Scheduled run at target_send_datetime (later)
  2) Manual run anytime (now)

RUN MODES (MUST EXIST IN THE DESIGN)
The app must support generating outcomes WITHOUT sending email.
- “Run Audit (no email)”:
  - runs validation rules and produces Findings + Run summary
  - stores artifacts metadata if generated
  - does NOT send email
- “Generate WIP report (no email)”:
  - produces WIP artifact(s) for download
  - does NOT send email
- “Generate Tip report (no email)”:
  - produces Tips artifact(s) for download
  - does NOT send email
- “Send Email” is a separate action that can be run after a successful audit/export generation.
  - The UI must be able to display outcome state (Findings, artifact links/status) without requiring email.

REPO REALITY / CURRENT STATE (DO NOT BREAK)
- server/src/api/routes.js exists and has /runs/manual and /runs/validate.
- server/src/domain/validationEngine.js exists as the “Findings contract” layer.
  - Finding fields: code, message, details, severity, status, emit_asana_alert.
  - emit_asana_alert controls Asana task creation (NOT status-based logic).
- server/src/domain/asanaTaskService.js must create tasks only when finding.emit_asana_alert === true.
- server/src/domain/exclusionsService.js exists with:
  - isExcluded(exclusions, employeeId, targetDate, scopeFlag)
  - buildExcludedEmployeeSet(exclusions, periodStart, periodEnd)
- Prisma migration includes an exclusions table with:
  - client_location_id, employee_name, toast_employee_id, reason, effective_from, effective_to, scope_flags, notes

IMPORTANT CONTRACT FREEZE (DO THIS NOW)
- Even if exclusions are stubbed, calls to runValidation must explicitly pass an exclusions argument
  (e.g. exclusions: []) to freeze the contract and prevent future refactors.
- Do NOT import helpers you don’t use. Don’t add buildExcludedEmployeeSet import unless used.

UI GOAL (LATER, BUT DESIGN MUST SUPPORT IT)
- Authentication: simple username/password (admin-controlled) later; can be stubbed now.
- First screen after login: “Choose Location”
  - searchable dropdown (type-to-filter), alphabetical list
  - locations come from Airtable later; for now stub backend provider shape
  - only show locations where PR Validation APP Active? = YES
- After location selection: show a header/menu with these sections (location-scoped):
  1) Implementation Audit (readiness checklist: Airtable required fields, payroll calendar present, rules configured, excluded staff options filled, etc.)
  2) Validation Rules (table of rules, per-location config)
  3) Excluded Staff (table per location; exclusions and per-surface toggles)
  4) Payroll Calendar (read-only from Airtable)
  5) Run Center (actions):
     - Run Audit (no email)
     - Generate WIP (no email)
     - Generate Tips (no email)
     - Send Email (separate, optional, post-run action)
- Outcomes must be visible in-app:
  - run status, findings count, findings list, artifact list (download links or paths), asana task status if applicable

EXPORTS / WIP / TIPS REQUIREMENTS
- Output format:
  - Tips report: XLSX
  - WIP report: XLSX
- File naming (exact):
  - Tips report: "[Location Name] Tips report PPE [DD.MM.YY].xlsx"
  - WIP report:  "[Location Name] WIP PPE [DD.MM.YY].xlsx"
- "PPE" means Pay Period Ending date = period_end.
- Date format for PPE in filenames is DD.MM.YY (two-digit year).
- Location Name must match the selected location display name exactly.
- Required headers for WIP must remain unchanged.
- Excluded Staff rules must be applied BEFORE writing rows:
  - If excluded from WIP → employee has no row in WIP XLSX
  - If excluded from Tips → employee has no row in Tips XLSX
  - If excluded from Audit → employee is not evaluated by validation rules





ASANA + ERROR HANDLING REQUIREMENTS
- Hybrid error logging:
  - Full log of all results (success+error) goes to a Google Sheet later (or persisted store).
  - Only errors create an Asana task for manual review.
  - Findings-triggered Asana tasks are separate and internal to payroll project.
- Asana tasks for findings are controlled by emit_asana_alert AND client/location routing (project/section).

DELIVERABLE EXPECTATIONS
- When asked for a change:
  - Identify current code (“what it is now”)
  - Provide exact “change it to” full replacement
  - If blocked by missing context, request screenshot of the exact file/UI view needed.
- Do not modify routes.js repeatedly in fragments. Deliver cohesive replacements.

DO NOT
- Do not add “demo rules” unless explicitly requested.
- Do not treat Asana as client-facing.
- Do not hardcode location lists long-term; locations are Airtable-driven.


