// server/src/domain/rulesConfigDb.js
// Postgres persistence for per-location payroll validation rule configuration (Tab 2)

const db = require('./db');

// Defaults when no row exists yet for a location + rule
const DEFAULTS = {
  active: true,
  internal_notification: false,
  asana_task_mode: 'SUMMARY', // SUMMARY | PER_FINDING
  client_active: null,
  client_include_to_email: null,
  params: null,
};

async function getRuleConfigsForLocation(clientLocationId) {
  const { rows } = await db.query(
    `SELECT rule_id, active, internal_notification, asana_task_mode, client_active, client_include_to_email, params
     FROM ops_rule_configs
     WHERE client_location_id = $1`,
    [clientLocationId]
  );

  const byRuleId = {};
  for (const r of rows) byRuleId[r.rule_id] = r;

  return { byRuleId, defaults: DEFAULTS };
}

async function upsertRuleConfig(clientLocationId, ruleId, config) {
  const active = config.active;
  const internalNotification = config.internal_notification;
  const asanaTaskMode = config.asana_task_mode || DEFAULTS.asana_task_mode;
  const params = config.params ?? null;

  await db.query(
    `INSERT INTO ops_rule_configs (
        client_location_id,
        rule_id,
        active,
        internal_notification,
        asana_task_mode,
        params,
        updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (client_location_id, rule_id)
     DO UPDATE SET
       active = EXCLUDED.active,
       internal_notification = EXCLUDED.internal_notification,
       asana_task_mode = EXCLUDED.asana_task_mode,
       params = EXCLUDED.params,
       updated_at = NOW()`,
    [
      clientLocationId,
      ruleId,
      active,
      internalNotification,
      asanaTaskMode,
      params,
    ]
  );
}

async function upsertClientRuleConfig(clientLocationId, ruleId, config) {
  const clientActive = config.client_active;
  const clientIncludeToEmail = config.client_include_to_email;
  const params = config.params ?? null;

  await db.query(
    `INSERT INTO ops_rule_configs (
        client_location_id,
        rule_id,
        active,
        internal_notification,
        asana_task_mode,
        client_active,
        client_include_to_email,
        params,
        updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (client_location_id, rule_id)
     DO UPDATE SET
       client_active = EXCLUDED.client_active,
       client_include_to_email = EXCLUDED.client_include_to_email,
       params = EXCLUDED.params,
       updated_at = NOW()`,
    [
      clientLocationId,
      ruleId,
      DEFAULTS.active,
      DEFAULTS.internal_notification,
      DEFAULTS.asana_task_mode,
      clientActive,
      clientIncludeToEmail,
      params,
    ]
  );
}

module.exports = {
  getRuleConfigsForLocation,
  upsertRuleConfig,
  upsertClientRuleConfig,
};
