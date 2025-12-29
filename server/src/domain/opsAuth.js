// server/src/domain/opsAuth.js
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function requireOpsToken(req, res, url) {
  const expected = process.env.OPS_TOKEN || "";
  // If no OPS_TOKEN is configured, allow (dev-friendly).
  if (!expected) return { ok: true };

  const token = (url.searchParams.get("ops_token") || "").trim();
  if (!token || token !== expected) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return { ok: false };
  }
  return { ok: true };
}

module.exports = { requireOpsToken };
