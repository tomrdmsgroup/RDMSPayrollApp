# docs/contracts/email-rendering.md

## Purpose

Email delivery is a first-class **Outcome delivery mode**.

Email is not an ad-hoc side effect. It is a deterministic rendering derived from a Run Outcome:
- standard payroll process language
- then appended audit findings (“process + results”)
- includes action buttons (Approve Payroll, Rerun Audit)
- addressing (recipients / from / reply-to) is Airtable-driven

This contract defines:
- how email subject/body is composed
- how findings are presented
- how action links appear
- what data is stored back onto the Outcome

---

## Inputs

Email rendering uses:

### 1) Outcome
- `outcome.findings[]`
- `outcome.actions.approve_url`
- `outcome.actions.rerun_url`
- `outcome.policy_snapshot` (drives addressing, schedule, and optional sections)

### 2) Delivery policy (resolved)
This is derived from Airtable and stored on the Outcome:
- `outcome.delivery.recipients[]`
- `outcome.delivery.from`
- `outcome.delivery.reply_to`
- `outcome.delivery.scheduled_send_at` (optional)

**Rule:**  
If `outcome.delivery.mode !== "email"`, email content MUST NOT be rendered or stored.

---

## Email subject

Default subject format:

