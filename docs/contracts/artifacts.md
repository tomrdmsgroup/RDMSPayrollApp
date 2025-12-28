# docs/contracts/artifacts.md

## Purpose

Artifacts are **generated outputs** produced by a payroll audit run that may be attached to an Outcome.

Artifacts are not side effects. They are:
- deterministic
- policy-driven
- versioned
- stored durably on the Outcome

This contract defines:
- what an artifact is
- how artifacts are identified
- how builders are invoked
- how artifacts are stored on Outcomes
- what is out of scope for Step 6

---

## Definition

An **Artifact** represents a generated file or report associated with a run.

Examples:
- Tips report
- Work-In-Progress (WIP) report

Artifacts are metadata records; the underlying file may be:
- embedded (base64)
- referenced (path / URL)
- generated later (future step)

Step 6 focuses on **artifact metadata**, not file storage mechanics.

---

## Artifact schema

Each artifact stored on an Outcome has this shape:

{
  "type": "tips_report",
  "label": "Tips Report",
  "builder": "tipsReportBuilder",
  "version": 1,
  "generated_at": "2026-01-01T00:00:00.000Z",
  "required": true,
  "status": "generated",
  "content": {
    "format": "csv",
    "rows": []
  }
}

---

## Policy-driven inclusion

Artifact generation is driven by policy snapshot fields.

Examples:
- Tips report required only if:
  - payroll company supports tips
  - tip report type is not NONE
- WIP report required only for certain payroll providers

Policy logic lives in the **artifact service**, not in routes or schedulers.

---

## Builders

Each artifact type has a dedicated builder module.

Builder contract:

buildArtifact({ run, policySnapshot })
→ { status, content }

Rules:
- Builders must be pure functions
- Builders must not mutate store state
- Builders must not perform I/O (Step 6)
- Errors are caught and surfaced as status: "failed"

---

## Artifact service

The artifact service:
- determines which artifacts apply for a run
- invokes builders
- normalizes artifact records
- returns an array of artifacts to attach to the Outcome

Artifacts are attached to:
outcome.artifacts[]

---

## Failure behavior

If an artifact builder fails:
- mark artifact status as "failed"
- record a durable failure
- do NOT fail the entire run

Outcome status is not automatically changed by artifact failure in Step 6.

---

## Non-goals (Step 6 scope)

Step 6 does NOT:
- write files to disk
- upload to cloud storage
- implement provider-specific data pulls
- format final client-ready documents
- block payroll approval based on artifacts

Step 6 locks:
- artifact contract
- builder structure
- attachment to outcomes
