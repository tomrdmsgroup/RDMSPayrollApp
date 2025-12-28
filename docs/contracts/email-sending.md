# docs/contracts/email-sending.md

## Purpose

Email sending is the act of taking a rendered Outcome email (subject/body + addressing) and delivering it via the configured provider.

This contract defines:
- required inputs for sending
- how provider configuration is read
- what is stored back onto the Outcome after sending
- behavior for failures and retries
- what is out of scope

---

## Preconditions (required)

Before sending, the system must have:

1) A Run
2) A saved Outcome for that run
3) `outcome.delivery.mode === "email"`
4) Addressing fields populated:
   - `outcome.delivery.recipients[]` (non-empty)
   - `outcome.delivery.from` (non-empty)
   - `outcome.delivery.reply_to` (optional)

5) Rendered content populated:
   - `outcome.delivery.subject`
   - `outcome.delivery.rendered_text` and/or `outcome.delivery.rendered_html`

Rendering is performed by `emailComposer.composeEmail(outcome, run)` (Step 2).

---

## Provider (SMTP)

Step 5 implements SMTP sending using env vars:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM` (default fallback if `outcome.delivery.from` is empty)

If required SMTP fields are missing, sending must fail safely and record a failure event.

---

## Outcome updates after sending

On successful send:

- `outcome.delivery.sent_at` set to now (ISO string)
- `outcome.delivery.provider_message_id` set if available
- Outcome `status` set to `delivered`

The system must persist these changes durably.

---

## Failure behavior

If sending fails:

- Do NOT crash the process
- Record a durable failure via `failureService.notifyFailure(...)`
- Do NOT set `sent_at`
- Outcome status remains unchanged (typically `completed` or `needs_attention`)

---

## Idempotency

Sending must be idempotent per run:

- If `outcome.delivery.sent_at` is already set, do not send again.
- Return a response indicating it was already sent.

---

## Ops endpoint behavior

`POST /ops/send-email/:runId`:

- Loads run + outcome
- Ensures delivery mode is email
- Ensures rendered content exists; if not, it renders first
- Sends email via provider
- Updates outcome delivery fields and status
- Returns delivery metadata

---

## Non-goals (Step 5 scope)

Step 5 does NOT:
- implement scheduling rules (Step 3 already defines planning)
- implement multiple providers
- implement authentication for ops
- build a UI
- implement complex retry queues

Step 5 locks:
- SMTP provider sending
- durable outcome delivery recording
- ops send endpoint behavior

---
