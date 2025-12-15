class IdempotencyService {
  constructor() {
    this.keys = new Map();
  }
  check(scope, key) {
    const scoped = this.keys.get(scope) || new Set();
    return scoped.has(key);
  }
  record(scope, key) {
    if (!this.keys.has(scope)) this.keys.set(scope, new Set());
    const scoped = this.keys.get(scope);
    if (scoped.has(key)) return false;
    scoped.add(key);
    return true;
  }
}

module.exports = { IdempotencyService };
