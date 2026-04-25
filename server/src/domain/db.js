// server/src/domain/db.js

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('missing_DATABASE_URL');
    pool = new Pool({
      connectionString: url,
      // Render internal Postgres URL does not require SSL
      ssl: false,
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

async function initDb() {
  // Existing durability tables (do not change contract)
  await query(
    `
    CREATE TABLE IF NOT EXISTS ops_runs (
      id SERIAL PRIMARY KEY,
      run JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ops_outcomes (
      run_id INTEGER PRIMARY KEY REFERENCES ops_runs(id) ON DELETE CASCADE,
      outcome JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ops_tokens (
      token TEXT PRIMARY KEY,
      token_row JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ops_period_approvals (
      id SERIAL PRIMARY KEY,
      client_location_id TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      approved_run_id INTEGER,
      approved_at TIMESTAMPTZ,
      approved_token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (client_location_id, period_start, period_end)
    );

    -- Staff auth tables
    CREATE TABLE IF NOT EXISTS staff_users (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('admin','staff')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS staff_sessions (
      token TEXT PRIMARY KEY,
      user_email TEXT NOT NULL REFERENCES staff_users(email) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Per location rule configuration (Tab 2)
    CREATE TABLE IF NOT EXISTS ops_rule_configs (
      client_location_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      active BOOLEAN NOT NULL,
      internal_notification BOOLEAN NOT NULL,
      asana_task_mode TEXT NOT NULL CHECK (asana_task_mode IN ('SUMMARY','PER_FINDING')),
      client_active BOOLEAN,
      client_include_to_email BOOLEAN,
      params JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (client_location_id, rule_id)
    );

    ALTER TABLE ops_rule_configs
      ADD COLUMN IF NOT EXISTS client_active BOOLEAN;

    ALTER TABLE ops_rule_configs
      ADD COLUMN IF NOT EXISTS client_include_to_email BOOLEAN;

    CREATE INDEX IF NOT EXISTS idx_ops_rule_configs_location
      ON ops_rule_configs (client_location_id);

    -- Communication setup: per-location recipient toggle for future client validation emails
    CREATE TABLE IF NOT EXISTS ops_validation_email_recipients (
      location_name TEXT NOT NULL,
      email TEXT NOT NULL,
      send_validation_email BOOLEAN NOT NULL DEFAULT TRUE,
      updated_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (location_name, email)
    );

    CREATE INDEX IF NOT EXISTS idx_ops_validation_email_recipients_location
      ON ops_validation_email_recipients (location_name);

    -- Excluded Staff (global ingress filter foundation)
    -- Additive only. No changes to existing tables or routes.
    CREATE TABLE IF NOT EXISTS excluded_staff (
      id SERIAL PRIMARY KEY,

      location_name TEXT NOT NULL,
      toast_employee_id TEXT NOT NULL,
      employee_name TEXT,

      reason TEXT NOT NULL,
      effective_from DATE,
      effective_to DATE,
      notes TEXT,

      active BOOLEAN NOT NULL DEFAULT TRUE,

      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),

      CONSTRAINT excluded_staff_effective_window_chk
        CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to)
    );

    CREATE INDEX IF NOT EXISTS idx_excluded_staff_lookup
      ON excluded_staff (location_name, toast_employee_id, active);


    -- Staff-uploaded Toast Payroll Export CSV audit baselines
    CREATE TABLE IF NOT EXISTS toast_payroll_baseline_uploads (
      id SERIAL PRIMARY KEY,
      location_name TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      file_name TEXT,
      raw_csv TEXT NOT NULL,
      raw_row_count INTEGER NOT NULL DEFAULT 0,
      normalized_row_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_toast_payroll_baseline_upload_lookup
      ON toast_payroll_baseline_uploads (location_name, period_start, period_end, uploaded_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS toast_payroll_baseline_rows (
      id SERIAL PRIMARY KEY,
      upload_id INTEGER NOT NULL REFERENCES toast_payroll_baseline_uploads(id) ON DELETE CASCADE,
      row_index INTEGER NOT NULL,
      stable_key TEXT NOT NULL,
      normalized_row JSONB NOT NULL,
      raw_row JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_toast_payroll_baseline_rows_upload
      ON toast_payroll_baseline_rows (upload_id, row_index);
    `,
    [],
  );

  // Seed Admin from env.ADMIN_EMAIL (if provided)
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (adminEmail) {
    await query(
      `
      INSERT INTO staff_users (email, role, status)
      VALUES ($1, 'admin', 'active')
      ON CONFLICT (email) DO UPDATE SET
        role = 'admin',
        status = 'active',
        updated_at = NOW()
      `,
      [adminEmail],
    );
  }
}

module.exports = {
  query,
  initDb,
};
