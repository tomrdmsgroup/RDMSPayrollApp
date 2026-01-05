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
