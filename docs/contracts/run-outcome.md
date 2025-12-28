# docs/contracts/run-outcome.md

## Purpose

A **Run Outcome** is the single durable record of what a payroll audit run produced and what should happen next.

It is the contract boundary between:
- running validations (inputs → findings)
- generating artifacts (attachments)
- delivering results (email / internal-only)
- workflow controls (approve / rerun)
- operations tooling (inspect / resend / rerun)

A run can be executed multiple times; each run produces exactly one current outcome.

---

## Definitions

### Run
A **Run** represents an execution attempt for a specific:
- `client_location_id`
- pay period (`period_start`, `period_end`)

Runs are stored in `store.runs[]`.

### Outcome
An **Outcome** represents the durable result for a run:
- findings
- artifacts
- delivery intent + delivery status
- action links
- policy snapshot (why rules/attachments/delivery were chosen)

Outcomes are stored in `store.outcomes[]`.

---

## Run lifecycle states (high level)

Run state is stored on the run record (`run.status`). Outcome has its own status.

### Run statuses
- `created`
- `running`
- `completed`
- `failed`

### Outcome statuses
- `needs_attention` (default when any failure findings exist)
- `completed` (run completed; no delivery performed yet)
- `delivered` (email sent successfully)
- `approved` (payroll approved via token workflow)
- `failed` (run failed; outcome exists with failure info)

Notes:
- Runs can be `completed` while the Outcome is not yet `delivered`.
- Approval is always tracked on the Outcome, not just the Run.

---

## Outcome schema

All fields below are part of the durable Outcome object.

```json
{
  "run_id": 123,
  "version": 1,
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z",

  "status": "completed",

  "summary": {
    "finding_counts": {
      "total": 0,
      "success": 0,
      "warning": 0,
      "failure": 0,
      "error": 0
    },
    "needs_attention": false
  },

  "findings": [
    {
      "code": "RULE_CODE",
      "status": "failure",
      "message": "Human readable message",
      "details": "Optional details",
      "emit_asana_alert": true,
      "scope_flags": { "audit": true, "wip": false, "tips": true }
    }
  ],

  "artifacts": [
    {
      "type": "tips_report",
      "required": true,
      "filename": "tips-report.pdf",
      "content_type": "application/pdf",
      "storage": { "kind": "inline_base64", "data": "..." }
    },
    {
      "type": "wip_report",
      "required": false,
      "filename": "wip.xlsx",
      "content_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "storage": { "kind": "inline_base64", "data": "..." }
    }
  ],

  "delivery": {
    "mode": "email",
    "scheduled_send_at": "2026-01-01T18:00:00.000Z",
    "sent_at": null,
    "provider_message_id": null,

    "recipients": ["client@example.com"],
    "from": "payroll@rdmsgroup.com",
    "reply_to": "client-reply@example.com",
    "subject": "Payroll Validation Results",
    "rendered_html": null,
    "rendered_text": null
  },

  "actions": {
    "approve_url": "https://.../approve?token=...",
    "rerun_url": "https://.../rerun?token=..."
  },

  "policy_snapshot": {
    "source": "airtable",
    "captured_at": "2026-01-01T00:00:00.000Z",
    "client_location_id": "LOC123",
    "payroll_company": "ADP_RUN",
    "tip_report_type": "TipHaus",
    "validation_send_time_local": "09:00",
    "validation_send_timezone": "America/Los_Angeles",
    "approval_recipients": ["ops@rdmsgroup.com"],
    "email_from": "payroll@rdmsgroup.com",
    "email_reply_to": "client@example.com"
  }
}
