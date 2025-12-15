class RuleRegistry {
  constructor() {
    this.rules = {};
  }
  register(code, definition) {
    this.rules[code] = definition;
  }
  validateConfig(code, params) {
    const rule = this.rules[code];
    if (!rule) throw new Error(`Unknown rule ${code}`);
    if (rule.paramsSchema) {
      const errors = rule.paramsSchema(params);
      if (errors.length) {
        const err = new Error(`Invalid params for ${code}: ${errors.join(';')}`);
        err.details = errors;
        throw err;
      }
    }
    return true;
  }
  executeAll(rulesToRun, context) {
    const results = [];
    rulesToRun.forEach((r) => {
      const rule = this.rules[r.code];
      if (!rule || r.enabled === false) return;
      const outcome = rule.run(context, r.params || {});
      results.push({ code: r.code, outcome });
    });
    return results;
  }
}

function numericParam(name) {
  return (params) => {
    const errors = [];
    if (params[name] === undefined || params[name] === null) errors.push(`${name} missing`);
    if (params[name] !== undefined && Number.isNaN(Number(params[name]))) errors.push(`${name} not numeric`);
    return errors;
  };
}

module.exports = { RuleRegistry, numericParam };
