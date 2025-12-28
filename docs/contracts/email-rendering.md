# docs/contracts/email-rendering.md

## Purpose

Email delivery is a first-class **Outcome delivery mode**.

Email is not an ad-hoc side effect. It is a deterministic rendering derived from a Run Outcome:
- standard payroll process language
- then appended audit findings ("process + results")
- includes action buttons (Approve Payroll, Rerun Audit)
- addressing (recipients/from/reply-to) is Airtable-driven

This contract defines:
- how email subject/body is composed
- how findings are presented
- how action links appear
- what data is stored back onto the Outcome

---

## Inputs

Email rendering uses:

1) **Outcome**
- `outcome.findings[]`
- `outcome.actions.approve_url`
- `outcome.actions.rerun_url`
- `outcome.policy_snapshot` (drives addressing + schedule + optional sections)

2) **Delivery policy (resolved)**
This is derived from Airtable and stored on Outcome:
- `outcome.delivery.recipients[]`
- `outcome.delivery.from`
- `outcome.delivery.reply_to`
- `outcome.delivery.scheduled_send_at` (optional)

---

## Email subject

Default subject format:

`Payroll Validation Results — {client_location_id} — {period_start} to {period_end}`

If `client_location_id` is unavailable, omit it.

---

## Email body structure ("process + results")

Email body is composed as:

1) **Standard Process Intro (fixed template)**
A stable, reusable paragraph describing what the email is:
- payroll validation completed
- findings below
- approve or rerun using buttons

2) **Action Buttons**
- APPROVE PAYROLL
- RERUN AUDIT

Buttons link to:
- `outcome.actions.approve_url`
- `outcome.actions.rerun_url`

3) **Results Section**
A heading: `Audit Findings`

Then a list of findings:
- grouped by status in this order:
  1) error
  2) failure
  3) warning
  4) success
- each finding shows:
  - code (if present)
  - message
  - details (if present)

4) **Footer**
Short footer line:
- “If you have questions, reply to this email.”

---

## Finding presentation rules

### Status mapping
Statuses are treated as normalized lowercase:
- `error`
- `failure`
- `warning`
- `success`

Unknown statuses appear under `warning`.

### Sorting
Within each status group:
- sort by `code` ascending (string compare)
- then by `message` ascending

### Format example (text)
Audit Findings

ERROR

[RULE_X] Something failed hard
Details: ...

FAILURE

[RULE_Y] Missing data for employee A

WARNING

[RULE_Z] Rounded minutes detected

SUCCESS

[RULE_OK] All checks passed for tips


### Format example (HTML)
Use a simple structure:
- headings for each group
- unordered list for findings
- optional details in smaller text

No CSS framework required.

---

## Action buttons (HTML)

Buttons should be plain HTML links styled minimally with inline attributes.

Example:
- APPROVE PAYROLL → `<a href="...">APPROVE PAYROLL</a>`
- RERUN AUDIT → `<a href="...">RERUN AUDIT</a>`

---

## Storage back onto Outcome

After composing email, store on `outcome.delivery`:

- `subject`
- `rendered_html`
- `rendered_text`

After sending successfully (Step 3+):
- `sent_at`
- `provider_message_id`
- outcome status transitions to `delivered`

---

## Delivery modes

- `outcome.delivery.mode = "email"` means the email is the delivery channel.
- `outcome.delivery.mode = "internal_only"` means no email should be generated or sent.

---

## Non-goals (not in Step 2)

Step 2 does NOT:
- send email via SMTP/provider
- schedule email sends
- implement cron
- implement UI

Step 2 only locks rendering and storage.

---
