CODEX SCOPE LOCK (RDMSPayrollApp)

Codex must NOT restructure the app.
Codex must ONLY implement features inside explicitly listed files/paths per step.

Authoritative contract: see Google Doc “RDMSPayrollApp Build Contract” (paste into Codex prompt when running).

Step ordering:
1) Validation Findings Contract + Asana gating (emit_asana_alert) + Exclusion decision contract
2) Rule catalog + per-location rule configs + exclusions per location
3) WIP XLSX + Tips XLSX generation (no email)
4) Run Center actions (audit no email, export no email, send email separate)
5) Airtable read-only providers for locations/calendar/vitals routing
6) Scheduling using PPE+1 day at PR Validation Send Time (timezone aware)

Boundaries (do not cross unless explicitly instructed):
- server/src/domain/* is domain logic
- server/src/api/* is HTTP routes only
- web/* is UI only
- failureService handles system failures (911), NOT findings
- findings create Asana tasks only when emit_asana_alert === true
- excluded employees are controlled per location per surface (audit/wip/tips) via scope flags

Deliverable rule:
- If asked for a change, provide full file replacements only (no partial snippets).
