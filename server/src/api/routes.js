// server/src/api/routes.js

const express = require('express');
const router = express.Router();

const { rulesCatalog } = require('../domain/rulesCatalog');
const rulesConfigDb = require('../domain/rulesConfigDb');

// Existing imports (unchanged)
const staffAuth = require('./staffAuth');
const airtable = require('../domain/airtable');

/* =============================
   Staff routes
   ============================= */

// Locations dropdown
router.get('/staff/locations', staffAuth.requireStaff, async (req, res) => {
  try {
    const locations = await airtable.getLocations();
    res.json({ ok: true, locations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'failed_to_load_locations' });
  }
});

// Tab 1 recap
router.get('/staff/recap', staffAuth.requireStaff, async (req, res) => {
  try {
    const locationName = req.query.locationName;
    if (!locationName) {
      return res.status(400).json({ ok: false, error: 'missing_locationName' });
    }

    const recap = await airtable.getRecapForLocation(locationName);
    res.json({ ok: true, recap });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'failed_to_load_recap' });
  }
});

/* =============================
   Tab 2: Payroll Validation Rules
   ============================= */

// Get rules + config for a location
router.get('/staff/rules', staffAuth.requireStaff, async (req, res) => {
  try {
    const locationName = req.query.locationName;
    if (!locationName) {
      return res.status(400).json({ ok: false, error: 'missing_locationName' });
    }

    const { byRuleId, defaults } = await rulesConfigDb.getRuleConfigsForLocation(locationName);

    const rules = rulesCatalog.map(rule => {
      const saved = byRuleId[rule.rule_id];
      return {
        rule_id: rule.rule_id,
        rule_name: rule.rule_name,
        definition: rule.definition,
        rationale: rule.rationale,
        api_type: rule.api_type,
        updated_api_type: rule.updated_api_type,
        params_required: rule.params_required,
        params_hint: rule.params_hint || null,

        active: saved ? saved.active : defaults.active,
        internal_notification: saved ? saved.internal_notification : defaults.internal_notification,
        asana_task_mode: saved ? saved.asana_task_mode : defaults.asana_task_mode,
        params: saved ? saved.params : defaults.params,
      };
    });

    res.json({ ok: true, rules });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'failed_to_load_rules' });
  }
});

// Save rule config for a location
router.put('/staff/rules', staffAuth.requireStaff, async (req, res) => {
  try {
    const locationName = req.query.locationName;
    const body = req.body;

    if (!locationName) {
      return res.status(400).json({ ok: false, error: 'missing_locationName' });
    }

    if (!body || !body.rule_id) {
      return res.status(400).json({ ok: false, error: 'missing_rule_id' });
    }

    await rulesConfigDb.upsertRuleConfig(locationName, body.rule_id, {
      active: body.active,
      internal_notification: body.internal_notification,
      asana_task_mode: body.asana_task_mode,
      params: body.params,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'failed_to_save_rule' });
  }
});

module.exports = router;
