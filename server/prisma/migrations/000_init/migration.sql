-- Initial schema reflecting binder minimum models
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Admin','User')),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_locations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  vitals_record_id TEXT NOT NULL,
  timezone TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rule_configs (
  id SERIAL PRIMARY KEY,
  client_location_id INTEGER REFERENCES client_locations(id),
  rule_code TEXT NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  params JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exclusions (
  id SERIAL PRIMARY KEY,
  client_location_id INTEGER REFERENCES client_locations(id),
  toast_employee_id TEXT NOT NULL,
  effective_from DATE,
  effective_to DATE,
  scope_flags JSONB DEFAULT '{}'::JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS runs (
  id SERIAL PRIMARY KEY,
  client_location_id INTEGER REFERENCES client_locations(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL,
  snapshot_metadata JSONB DEFAULT '{}'::JSONB,
  toast_metadata JSONB DEFAULT '{}'::JSONB,
  rules_metadata JSONB DEFAULT '{}'::JSONB,
  artifacts_metadata JSONB DEFAULT '{}'::JSONB,
  email_metadata JSONB DEFAULT '{}'::JSONB,
  asana_metadata JSONB DEFAULT '{}'::JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS run_events (
  id SERIAL PRIMARY KEY,
  run_id INTEGER REFERENCES runs(id),
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL,
  payload JSONB DEFAULT '{}'::JSONB
);

CREATE TABLE IF NOT EXISTS artifacts (
  id SERIAL PRIMARY KEY,
  run_id INTEGER REFERENCES runs(id),
  artifact_type TEXT NOT NULL,
  path TEXT NOT NULL,
  checksum TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tokens (
  id SERIAL PRIMARY KEY,
  token_id TEXT UNIQUE NOT NULL,
  run_id INTEGER REFERENCES runs(id),
  period_start DATE,
  period_end DATE,
  action TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  clicked_at TIMESTAMPTZ,
  recipient_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approvals (
  id SERIAL PRIMARY KEY,
  run_id INTEGER REFERENCES runs(id),
  period_start DATE,
  period_end DATE,
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id SERIAL PRIMARY KEY,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(scope, idempotency_key)
);
