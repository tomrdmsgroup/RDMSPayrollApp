// server/src/domain/persistenceStore.js
// Minimal JSON-file persistence for binder-scoped config tables.

const fs = require('fs');
const path = require('path');

const dataFilePath = () => process.env.APP_DATA_FILE || path.join(__dirname, '..', '..', 'data', 'store.json');

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

function readStore() {
  ensureDataFile();
  const raw = fs.readFileSync(dataFilePath(), 'utf-8');
  try {
    const parsed = JSON.parse(raw || '{}');
    return {
      ...defaultData(),
      ...parsed,
      client_locations: Array.isArray(parsed.client_locations) ? parsed.client_locations : [],
      rule_configs: Array.isArray(parsed.rule_configs) ? parsed.rule_configs : [],
      exclusions: Array.isArray(parsed.exclusions) ? parsed.exclusions : [],
    };
  } catch (e) {
    return defaultData();
  }
}

function writeStore(store) {
  ensureDataFile();
  fs.writeFileSync(dataFilePath(), JSON.stringify(store, null, 2));
  return store;
}

function resetStore() {
  return writeStore(defaultData());
}

function nextId(collection = []) {
  return collection.reduce((max, row) => {
    const val = Number(row?.id);
    if (Number.isFinite(val) && val > max) return val;
    return max;
  }, 0) + 1;
}

module.exports = {
  dataFilePath,
  readStore,
  writeStore,
  resetStore,
  nextId,
};
