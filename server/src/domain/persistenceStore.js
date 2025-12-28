// server/src/domain/persistenceStore.js
// Minimal JSON-file persistence for binder-scoped config tables + run/token/idempotency/failure durability.

const fs = require('fs');
const path = require('path');

const dataFilePath = () =>
  process.env.APP_DATA_FILE || path.join(__dirname, '..', '..', 'data', 'store.json');

function defaultData() {
  return {
    // Binder-scoped config tables
    client_locations: [],
    rule_configs: [],
    exclusions: [],

    // Durable operational state (audits 3/4)
    runs: [],
    tokens: [],
    idempotency: {}, // { [scope: string]: string[] }
    failures: [], // [{ occurred_at, ...payload }]

    // Simple counters for stable incremental IDs
    counters: {
      run_id: 1,
    },
  };
}

function ensureDataFile() {
  const file = dataFilePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultData(), null, 2));
  }
}

function safeParseOrThrow(raw, file) {
  try {
    const parsed = JSON.parse(raw || '{}');
    const base = defaultData();

    const merged = {
      ...base,
      ...parsed,
    };

    merged.client_locations = Array.isArray(parsed.client_locations) ? parsed.client_locations : [];
    merged.rule_configs = Array.isArray(parsed.rule_configs) ? parsed.rule_configs : [];
    merged.exclusions = Array.isArray(parsed.exclusions) ? parsed.exclusions : [];

    merged.runs = Array.isArray(parsed.runs) ? parsed.runs : [];
    merged.tokens = Array.isArray(parsed.tokens) ? parsed.tokens : [];
    merged.failures = Array.isArray(parsed.failures) ? parsed.failures : [];

    merged.idempotency =
      parsed && typeof parsed.idempotency === 'object' && !Array.isArray(parsed.idempotency)
        ? parsed.idempotency
        : {};

    merged.counters =
      parsed && typeof parsed.counters === 'object' && !Array.isArray(parsed.counters)
        ? { ...base.counters, ...parsed.counters }
        : { ...base.counters };

    if (!Number.isFinite(Number(merged.counters.run_id)) || Number(merged.counters.run_id) < 1) {
      merged.counters.run_id = 1;
    }

    return merged;
  } catch (err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${file}.corrupt-${stamp}.bak`;
    try {
      fs.writeFileSync(backup, raw || '');
    } catch (_) {
      // If backup fails, we still throw; do not silently wipe.
    }
    const e = new Error('persistence_store_corrupt');
    e.cause = err;
    e.backup = backup;
    throw e;
  }
}

function readStore() {
  ensureDataFile();
  const file = dataFilePath();
  const raw = fs.readFileSync(file, 'utf-8');
  return safeParseOrThrow(raw, file);
}

function atomicWriteFile(file, content) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.store.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function writeStore(store) {
  ensureDataFile();
  const file = dataFilePath();
  const payload = JSON.stringify(store, null, 2);
  atomicWriteFile(file, payload);
  return store;
}

function updateStore(mutator) {
  const current = readStore();
  const next = mutator ? mutator(current) : current;
  return writeStore(next || current);
}

function resetStore() {
  return writeStore(defaultData());
}

function nextId(collection = []) {
  return (
    collection.reduce((max, row) => {
      const val = Number(row?.id);
      if (Number.isFinite(val) && val > max) return val;
      return max;
    }, 0) + 1
  );
}

function nextCounter(store, counterName) {
  if (!store || typeof store !== 'object') return 1;
  if (!store.counters || typeof store.counters !== 'object') store.counters = {};
  const current = Number(store.counters[counterName] || 1);
  const safe = Number.isFinite(current) && current >= 1 ? current : 1;
  store.counters[counterName] = safe + 1;
  return safe;
}

module.exports = {
  dataFilePath,
  readStore,
  writeStore,
  updateStore,
  resetStore,
  nextId,
  nextCounter,
};
