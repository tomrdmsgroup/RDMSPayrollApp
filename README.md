# RDMS Payroll App (stub)

This repository contains a skeleton implementation of the internal payroll automation platform described in the Payroll App Binder (V1.0–V1.2). The code is designed for offline environments and uses lightweight Node.js modules without external dependencies.

## Structure
- `server/` – Node.js backend with domain services, provider stubs, HTTP endpoints, SQL migration, and unit tests.
- `web/` – Minimal React-in-the-browser console for login and manual actions.
- `docs/` – Binder documents provided for reference (closed-world contract).

## Backend
The backend avoids external packages and implements required domains with in-memory and file-based stubs. Production deployments should replace provider stubs with real integrations and wire a PostgreSQL client to the SQL schema.

### Running
```
cd server
node src/index.js
```

### Tests
```
cd server
npm test
```

### Environment
Populate a `.env` file based on `.env.example` to configure defaults (admin credentials, provider tokens, etc.).

## Database
SQL migrations live under `server/prisma/migrations/000_init/migration.sql`, expressing the minimum schema from the binder: users, client_locations, rule_configs, exclusions, runs, run_events, artifacts, tokens, approvals, and idempotency_keys.

## Frontend
The `web/index.html` page loads React from a CDN and provides stub login, manual run creation, and idempotency dashboard calls to the backend. Serve the `web/` directory with any static server while the backend is running on the same origin.

## Notes
- Toast, Airtable, email, and Asana providers are intentionally stubbed but maintain required interfaces and failure semantics.
- Failures call the 911 protocol via `failureService` to avoid silent errors.
- Export generation enforces ADP RUN/WFN WIP column contracts and fails loudly if mandatory fields (e.g., WFN CO CODE) are absent.
