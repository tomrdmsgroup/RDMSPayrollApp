# docs/contracts/ops-actions.md

## Purpose

Operations (“ops”) endpoints provide controlled, internal access to:
- run audits on demand
- rerun audits
- inspect run + outcome state
- render and send email on demand

These endpoints are intended for internal verification and manual intervention.

This contract defines:
- endpoint list
- request/response shape
- what each endpoint is allowed to do
- what is explicitly out of scope for Step 4

---

## Base path

All ops endpoints are mounted under:

/ops

Responses are JSON.

---

## Endpoints

### 1) Health / status

GET /ops/status

Returns a lightweight object confirming the ops router is mounted.

Response:
{
  "ok": true
}

---

### 2) Create and run an audit (run now)

POST /ops/run

Request body:
{
  "client_location_id": "LOC123",
  "period_start": "2026-01-01",
  "period_end": "2026-01-07",
  "policy_snapshot": {}
}

Behavior:
- Creates a Run
- Builds and saves an Outcome
- Does not send email

Response:
{
  "ok": true,
  "run": { "...": "..." },
  "outcome": { "...": "..." }
}

---

### 3) Rerun an audit for an existing run

POST /ops/rerun/:runId

Behavior:
- Creates a new Run using the same client/location and period
- Saves a new Outcome
- Does not delete old run/outcome

Response:
{
  "ok": true,
  "previous_run_id": 123,
  "run": { "...": "..." },
  "outcome": { "...": "..." }
}

---

### 4) Inspect a run + outcome

GET /ops/run/:runId

Response:
{
  "ok": true,
  "run": { "...": "..." },
  "outcome": { "...": "..." }
}

If run not found:
{
  "ok": false,
  "error": "run_not_found"
}

---

### 5) Render email for a run (no send)

POST /ops/render-email/:runId

Behavior:
- Loads run + outcome
- Requires outcome.delivery.mode === "email"
- Renders subject + body
- Stores rendered fields on outcome.delivery

Response:
{
  "ok": true,
  "delivery": {
    "subject": "...",
    "rendered_text": "...",
    "rendered_html": "..."
  }
}

---

### 6) Send email now

POST /ops/send-email/:runId

Step 4 behavior:
- Endpoint exists but may return stub

Stub response:
{
  "ok": false,
  "error": "email_send_not_implemented"
}

---

## Access / security

No authentication is implemented in Step 4.
Endpoints are assumed to be protected upstream.

---

## Non-goals (Step 4 scope)

Step 4 does NOT:
- build a UI
- implement authentication
- implement a hosted scheduler
- expand validation or artifact generation
- change business logic

Step 4 locks:
- ops control surface
- safe manual execution paths


