RDMS Payroll App (stub)

This repository contains a skeleton implementation of the internal payroll automation platform described in the Payroll App Binder (V1.0–V1.2).

The code is intended as a closed-world reference implementation:

it reflects the contracts described in the binder,

it is not feature-complete,

and it is meant to be stabilized before additional functionality is layered on.

Runtime Requirements

Node.js 18 or newer
Required because several providers rely on the built-in fetch API.

Structure

server/ – Node.js backend with domain services, provider stubs, HTTP endpoints, SQL migration, and unit tests.

web/ – Minimal React-in-the-browser console for login and manual actions.

docs/ – Binder documents provided for reference (closed-world contract).

CODEX_*.md – Contract and instruction files used for AI-assisted development.

Backend

The backend implements required domains using a mix of in-memory logic and file-based persistence.

External integrations (Toast, Airtable, email, Asana) are present as providers with real interfaces, but may operate in stub mode depending on configuration.

Production deployments are expected to wire a real database client to the provided SQL schema and supply provider credentials via environment variables.

Running

cd server
npm install
node src/index.js

Tests

cd server
npm test

Tests validate current contract behavior and are intentionally lightweight.

Environment

Populate a .env file based on server/.env.example.
The server loads environment variables only from server/.env.

Database

SQL migrations live under:

server/prisma/migrations/000_init/migration.sql

This schema reflects the minimum entities defined in the binder.

Frontend

The web/index.html page provides a minimal internal console for login, manual run creation, and idempotency inspection. Serve it from the same origin as the backend.

Notes

Providers maintain required interfaces and failure semantics.

System failures are routed through the 911 protocol via failureService.

Export generation enforces ADP RUN / WFN WIP column contracts and fails loudly when mandatory fields are missing.
