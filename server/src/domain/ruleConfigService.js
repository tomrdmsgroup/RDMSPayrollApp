// server/src/domain/ruleConfigService.js
// Step 2 foundation: per-location rule enablement + params.
// Stubbed in-memory store for now (Airtable comes later).

const store = new Map(); // key: `${clientLocationId}::${ruleCode}` -> { ruleCode, enabled, params }

function normalizeRuleConfig(ruleCode, input = {}) {
  const enabled = input.enabled !== false; // default true
  const params = input.params && typeof input.params === 'object' ? input.params : {};
  return { ruleCode, enabled, params };
}

function getRuleConfigsForLocation(clientLocationId) {
  const result = [];
  for (const [key, value] of store.entries()) {
    if (key.startsWith(`${clientLocationId}::`)) result.push(value);
  }
  // stable ordering
  result.sort((a, b) => `${a.ruleCode}`.localeCompare(`${b.ruleCode}`));
  return result;
}

function getRuleConfig(clientLocationId, ruleCode) {
  const key = `${clientLocationId}::${ruleCode}`;
  return store.get(key) || null;
}

function setRuleConfig(clientLocationId, ruleCode, input = {}) {
  const key = `${clientLocationId}::${ruleCode}`;
  const normalized = normalizeRuleConfig(ruleCode, input);
  store.set(key, normalized);
  return normalized;
}

function deleteRuleConfig(clientLocationId, ruleCode) {
  const key = `${clientLocationId}::${ruleCode}`;
  return store.delete(key);
}

module.exports = {
  getRuleConfigsForLocation,
  getRuleConfig,
  setRuleConfig,
  deleteRuleConfig,
};
