// server/src/domain/idempotencyService.js

const { updateStore } = require('./persistenceStore');

class IdempotencyService {
  constructor(scope = 'default') {
    this.scope = scope;
  }

  /**
   * Record an idempotency key for a given scope.
   * Returns true if the key was newly recorded.
   * Returns false if the key already exists.
   */
  record(type, key) {
    if (!type || !key) return false;

    const bucket = `${type}`;

    let recorded = false;

    updateStore((store) => {
      if (!store.idempotency[bucket]) {
        store.idempotency[bucket] = [];
      }

      if (store.idempotency[bucket].includes(key)) {
        recorded = false;
        return store;
      }

      store.idempotency[bucket].push(key);
      recorded = true;
      return store;
    });

    return recorded;
  }

  /**
   * Check whether a key has already been recorded.
   */
  has(type, key) {
    if (!type || !key) return false;

    let exists = false;

    updateStore((store) => {
      exists = Array.isArray(store.idempotency[type])
        ? store.idempotency[type].includes(key)
        : false;
      return store;
    });

    return exists;
  }

  /**
   * Clear all idempotency keys for a given type.
   * Intended for controlled resets only.
   */
  clear(type) {
    if (!type) return;

    updateStore((store) => {
      store.idempotency[type] = [];
      return store;
    });
  }
}

module.exports = {
  IdempotencyService,
};
