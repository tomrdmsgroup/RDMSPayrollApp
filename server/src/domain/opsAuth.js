// server/src/domain/opsAuth.js
//
// Simple ops-token guard used by ops routes.
// Checks the request-supplied token against env OPS_TOKEN.

function requireOpsToken(providedToken) {
  const expected = process.env.OPS_TOKEN;

  if (!expected || String(expected).trim() === '') {
    // If OPS_TOKEN isn't set on the server, fail closed (safer).
    throw new Error('ops_token_not_configured');
  }

  const got = String(providedToken || '').trim();
  if (!got) throw new Error('ops_token_missing');

  if (got !== String(expected).trim()) {
    throw new Error('ops_token_invalid');
  }

  return true;
}

module.exports = { requireOpsToken };
