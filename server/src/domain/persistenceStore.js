// server/src/domain/persistenceStore.js
// Minimal JSON-file persistence for binder-scoped config tables.

const fs = require('fs');
const path = require('path');

const dataFilePath = () =>
  process.env.APP_DATA_FILE || path.join(__dirname, '..', '..', 'data', 'store.json');

function defaultData() {
  return {
    client_locations: [],
    rule_configs: [],
    exclusions: [],
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
    return {
      ...defaultData(),
      ...parsed,
      client_locations: Array.isArray(parsed.client_locations) ? parsed.client_locations : [],
      rule_configs: Array.isArray(parsed.rule_configs) ? parsed.rule_configs : [],
      exclusions: Array.isArray(parsed.exclusions) ? parsed.exclusions : [],
    };
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

module.exports = {
  dataFilePath,
  readStore,
  writeStore,
  resetStore,
  nextId,
};
