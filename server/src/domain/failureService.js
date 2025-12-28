// server/src/domain/failureService.js

const { updateStore } = require('./persistenceStore');

function nowIso() {
  return new Date().toISOString();
}

/**
 * Durable failure notifier.
 * - Writes failure payloads into the persistence store (store.failures)
 * - Also logs to console for visibility in hosted environments
 *
 * This keeps current behavior compatible while making failures durable.
 */
function notifyFailure(payload) {
  const entry = {
    occurred_at: nowIso(),
    ...(payload || {}),
  };

  try {
    updateStore((store) => {
      store.failures.push(entry);
      return store;
    });
  } catch (err) {
    // If persistence is broken, we still log to console.
    // Do not throw; failures should not crash the server.
  }

  try {
    // eslint-disable-next-line no-console
    console.error('[failure]', JSON.stringify(entry));
  } catch (_) {
    // ignore
  }

  return entry;
}

module.exports = {
  notifyFailure,
};
