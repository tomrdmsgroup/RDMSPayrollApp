# docs/contracts/scheduling.md

## Purpose

Scheduling is treated as **data-driven intent**, not cron-driven behavior.

A scheduler (human-triggered or hosted) calls a single function ("tick") that:
1) loads policy (Airtable snapshot)
2) determines what should happen (plan)
3) executes the plan idempotently
4) records durable outcomes / failures

This contract defines:
- how we compute what runs should execute
- how we compute when emails should send
- what the scheduler tick must do
- what is explicitly out of scope for Step 3

---

## Inputs

Scheduling uses:

1) **Policy snapshot**
Derived from Airtable (Vitals), per client/location, including:
- payroll calendar / pay frequency
- validation send time (local time)
- validation timezone
- email addressing fields
- flags for required artifacts (tips/WIP)
- any "enabled/disabled" flag for automation

2) **Now**
The current time used by scheduler tick.

3) **Existing durable state**
- runs (`store.runs[]`)
- outcomes (`store.outcomes[]`)
- tokens
- failures
- idempotency keys

---

## Concepts

### Intended Actions

Scheduler does not "do everything". It produces a list of **intended actions**:

- `RUN_AUDIT`
  - run validations + generate findings/artifacts
  - build and save outcome
  - determine delivery mode and scheduled send time (if email delivery)

- `SEND_EMAIL`
  - compose email from saved outcome
  - send via provider (future step)
  - store rendered bodies + sent timestamp + provider message id

Step 3 includes planning and tick execution structure.
Actual sending can be a stub until provider wiring is finished.

---

## Planning rules

### Run planning ("when to run")
For each client/location:
- Determine the most recent pay period that has ended and should be validated.
- If a run for that client/location + pay period does not exist, schedule `RUN_AUDIT`.

Run uniqueness key:
- `{client_location_id}|{period_start}|{period_end}`

### Email planning ("when to send")
For each run outcome where:
- `outcome.delivery.mode === "email"`
- `outcome.delivery.scheduled_send_at` is set
- `outcome.delivery.sent_at` is null
- current time >= scheduled_send_at

Schedule `SEND_EMAIL` for that run.

---

## Scheduler Tick contract

Scheduler tick does:

1) Load policy snapshot (Airtable Vitals)
2) Plan intended actions
3) Execute each action safely:
   - use idempotency keys
   - record failures durably (failure service)
4) Return a summary object:
   - actions planned
   - actions executed
   - failures recorded

Scheduler tick must never crash the process for a single client error.
Failures must be logged and the tick continues to other clients.

---

## Storage

Planner outputs actions; tick execution updates:

- runs (create/update)
- outcomes (create/update)
- failures
- idempotency

No new storage structures beyond what's already durable.

---

## Non-goals (Step 3 scope)

Step 3 does NOT:
- define Airtable schema (assumes policy snapshot already exists)
- implement a real cron job / hosted scheduler
- build UI
- fully implement provider-specific email sending
- implement tips/WIP artifact generation details (those are separate providers/artifact builders)

Step 3 locks:
- the planning contract
- the tick entrypoint
- how intent becomes durable state

---
