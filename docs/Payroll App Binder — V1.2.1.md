# Payroll App Binder — V1.2.1 (AUTHORITATIVE)

⚠️ CLOSED WORLD SPEC
This document is the ONLY authoritative specification for the RDMS Payroll Validation App.
All prior binder versions are historical and MUST NOT be referenced or inferred from.

If a requirement is not explicitly stated here, it does not exist.

Payroll App Binder — V1.2.1
Version note: V1.2.1 is a tightening of V1.2 based on clarified business invariants. No architectural changes are introduced here.
Change log (from V1.2)
• Clarified approval locking semantics (first successful approval locks the period/run; timeout locks all).
• Clarified that system integrity failures (broken send/buttons/audit rendering) are the critical failures to detect and surface immediately.
• Clarified Step 1 testing posture: temporary test credentials may be used for ToastProvider bring-up, but Airtable remains stubbed until Step 2.
1. Authentication (Required)
1.1 Login Method
Users authenticate with:


email (username)


password


No SSO, no OAuth, no magic links, no MFA requirements in V1.2 unless explicitly added later.


1.2 Password Requirements
Passwords must be stored securely (hashed + salted).


Password reset exists (email-based reset link to the user’s email).


1.3 Sessions
After login, the user has an authenticated session.


Session expiration is required (reasonable timeout); on expiration user must log in again.



2. Authorization (Basic, Not Complicated)
2.1 Default Role Model
V1.2 defines exactly two roles:
Admin


Can access everything.


Can manage users (create/disable/reset).


Can change all client/location app-owned configuration:


rule enablement/params


exclusions


manual actions (run/send/generate/resend/reissue)


Can view all logs and failures.


User


Can access the internal ops console.


Can run allowed manual actions and update client-specific app-owned items as permitted by V1.2 rules (below).


2.2 Simple Permission Rules
By default, Users can do everything that an internal operator needs:


select client/location, select period


run validations


generate exports


generate tip report


send/resend email


reissue tokens (subject to the guardrails in V1.1)


update rule enablement/params


update exclusions


The only features reserved for Admin:


user management (create, disable, reset password)


any “override” capability if one is ever introduced (none exist by default)


This keeps roles simple while still preventing “anyone can add accounts.”

3. User Management (Required)
3.1 Admin-Managed Accounts
Users are created by Admins.


Each user has:


email


role (Admin/User)


status (Active/Disabled)


3.2 Disablement
Disabled users cannot log in.


Disablement does not delete audit history.



4. Audit Logging (Tied to Auth)
Any change to app-owned configuration or manual actions must record:
who performed it (user email)


when


what changed


for which client/location/period


This applies to:
rule configuration


exclusions


manual runs/sends/resends


token reissue actions



Payroll App Binder — V1.2 Complete
This adds internal authentication and a minimal role model:
Email + password


Two roles (Admin, User)


Admin-managed accounts


Audit logging tied to identity


No additional complexity is introduced.

9. Clarifications (V1.2.1)
9.1 Approval and Locking Semantics
• Approval is a first-write-wins lock: the first successful approval action locks the pay period for that location.
• Multiple recipients may receive emails and multiple links may exist. Stale/older approval links are allowed to be clicked; the lock is what governs the outcome.
• Once the period is approved (locked), subsequent approval attempts must be rejected as already locked.
• If the approval window times out, approval is not possible and the period is treated as locked (no approvals can succeed).
9.2 What Counts as a Failure
• Business findings (validation results) are not system failures; they may produce findings but the run can still proceed.
• System integrity failures are critical and must be detected and surfaced immediately: email not sent when expected, approve/rerun endpoints broken, audit/validation page failing to render, required attachments/artifacts missing, or provider calls failing.
• When a critical system failure occurs, the run must enter the failure protocol path (911) and the issue must be visible in the run UI and logs.
9.3 Provider Wiring Discipline
• Provider stubs must not be collapsed prematurely. Implement providers in order (Toast, then Airtable read-only, then Email+tokens, then Asana).
• For Step 1 (ToastProvider), it is acceptable to use temporary test credentials/config to validate real Toast API pulls. This is explicitly a testing bridge; Airtable remains stubbed until Step 2.
