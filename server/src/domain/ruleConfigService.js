// server/src/domain/ruleConfigService.js
// Persistence-backed rule config store (per location).

const { readStore, writeStore, nextId } = require('./persistenceStore');

function normalizeRuleConfig(ruleCode, input = {}) {
  const code = `${ruleCode || ''}`.trim();
  if (!code) throw new Error('rule_code_required');

  const enabled = input.enabled !== false;
  const params = input.params && typeof input.params === 'object' ? input.params : {};
  const emit_asana_alert = input.emit_asana_alert === true;

  return { rule_code: code, enabled, params, emit_asana_alert };
}

function getRuleConfigsForLocation(clientLocationId) {
  const data = readStore();
  const rows = data.rule_configs.filter((r) => Number(r.client_location_id) === Number(clientLocationId));
  rows.sort((a, b) => `${a.rule_code}`.localeCompare(`${b.rule_code}`));
  return rows;
}

function getRuleConfig(clientLocationId, ruleCode) {
  const data = readStore();
  return (
    data.rule_configs.find(
      (r) => Number(r.client_location_id) === Number(clientLocationId) && `${r.rule_code}` === `${ruleCode}`
    ) || null
  );
}

function setRuleConfig(clientLocationId, ruleCode, input = {}) {
  const data = readStore();
  const normalized = normalizeRuleConfig(ruleCode, input);
  const now = new Date().toISOString();

  const idx = data.rule_configs.findIndex(
    (r) => Number(r.client_location_id) === Number(clientLocationId) && `${r.rule_code}` === `${normalized.rule_code}`
  );

  if (idx !== -1) {
    const existing = data.rule_configs[idx];
    data.rule_configs[idx] = {
      ...existing,
      ...normalized,
      client_location_id: existing.client_location_id,
      id: existing.id,
      created_at: existing.created_at,
      updated_at: now,
    };
    writeStore(data);
    return data.rule_configs[idx];
  }

  const row = {
    ...normalized,
    id: nextId(data.rule_configs),
    client_location_id: Number(clientLocationId),
    created_at: now,
    updated_at: now,
  };

  data.rule_configs.push(row);
  writeStore(data);
  return row;
}

function deleteRuleConfig(clientLocationId, ruleCode) {
  const data = readStore();
  const before = data.rule_configs.length;
  data.rule_configs = data.rule_configs.filter(
    (r) => Number(r.client_location_id) !== Number(clientLocationId) || `${r.rule_code}` !== `${ruleCode}`
  );
  writeStore(data);
  return data.rule_configs.length < before;
}

module.exports = {
  getRuleConfigsForLocation,
  getRuleConfig,
  setRuleConfig,
  deleteRuleConfig,
};
