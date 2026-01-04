// server/src/domain/db.js

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('missing_DATABASE_URL');
    pool = new Pool({
      connectionString: url,
      ssl: false, // Render internal URL does not require SSL
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

async function initDb() {
  // Minimal tables for ops durability, stored as JSON to avoid schema mismatches.
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
    `,
    [],
  );
}

module.exports = {
  query,
  initDb,
};
