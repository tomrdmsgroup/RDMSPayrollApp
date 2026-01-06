// server/src/api/routes.js

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const { issueToken } = require('../domain/tokenService');
const { createRunRecord, appendEvent, failRun, getRun } = require('../domain/runManager');
const { approveAction, rerunAction } = require('../domain/approvalService');
const { IdempotencyService } = require('../domain/idempotencyService');
const { notifyFailure } = require('../domain/failureService');
const { runValidation } = require('../domain/validationEngine');

const { rulesCatalog } = require('../domain/rulesCatalog');
const { getRuleConfigsForLocation, upsertRuleConfig } = require('../domain/rulesConfigDb');

const {
  createSessionForEmail,
  getUserBySessionToken,
  logoutSession,
  issueSessionToken,
  getStaffUserFromRequest,
  setSessionCookie,
} = require('../domain/sessionService');

const {
  listLocationNames,
  getRecapForLocationName,
} = require('../domain/airtableRecapService');

const { googleOauthStart, googleOauthCallback } = require('../domain/googleOauth');
const { requireAdmin } = require('../domain/staffAdmin');
const { listStaffUsers, createStaffUser, deleteStaffUser } = require('../domain/staffUsersDb');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body || {}));
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body || '');
}

function handleError(res, err) {
  console.error('routes_error', err);
  json(res, 500, { error: 'server_error', message: err && err.message ? err.message : String(err) });
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch (_) {
        resolve({});
      }
    });
  });
}

function cookieMap(req) {
  const header = (req.headers && req.headers.cookie) || '';
  const out = {};
  header.split(';').forEach((p) => {
    const [k, ...rest] = p.trim().split('=');
    if (!k) return;
    out[k] = decodeURIComponent(rest.join('=') || '');
  });
  return out;
}

function readStaffHtml() {
  try {
    const filePath = path.join(__dirname, '../../web/staff.html');
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return `<html><body style="font-family:Arial;padding:24px;">Missing staff.html</body></html>`;
  }
}

function staffHtml() {
  return readStaffHtml();
}

async function requireStaff(req, res) {
  const user = await getStaffUserFromRequest(req);
  if (!user) {
    json(res, 401, { error: 'staff_login_required' });
    return null;
  }
  return user;
}

function router(req, res) {
  const host = req.headers && req.headers.host ? req.headers.host : 'localhost';
  const url = new URL(req.url || '/', `http://${host}`);

  if (url.pathname === '/health') return json(res, 200, { ok: true });

  // Convenience: send root to staff console
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(302, { Location: '/staff' });
    res.end();
    return;
  }

  // Staff UI page
  if (url.pathname === '/staff' && req.method === 'GET') {
    (async () => {
      const user = await getStaffUserFromRequest(req);
      if (!user) {
        res.writeHead(302, { Location: '/auth/google' });
        res.end();
        return;
      }
      return html(res, 200, staffHtml());
    })();
    return;
  }

  // Staff Auth (Google)
  if (url.pathname === '/auth/google' && req.method === 'GET') {
    return googleOauthStart(req, res);
  }

  if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
    (async () => {
      try {
        const { ok, email, error } = await googleOauthCallback(req, res);
        if (!ok) {
          return html(
            res,
            403,
            `<html><body style="font-family:Arial;padding:24px;">Login failed: ${error || 'unknown_error'}</body></html>`,
          );
        }

        const session = await createSessionForEmail(email);
        if (!session) {
          return html(
            res,
            403,
            `<html><body style="font-family:Arial;padding:24px;">
              Access denied. Your account is not enabled for this app.<br/><br/>
              Email: ${email}
            </body></html>`,
          );
        }

        setSessionCookie(res, session.token);
        res.writeHead(302, { Location: '/staff' });
        res.end();
      } catch (e) {
        return html(res, 500, `<html><body style="font-family:Arial;padding:24px;">Login failed: ${e.message}</body></html>`);
      }
    })();
    return;
  }

  if (url.pathname === '/auth/me' && req.method === 'GET') {
    (async () => {
      try {
        const cookies = cookieMap(req);
        const token = cookies && cookies.session ? cookies.session : null;
        const user = token ? await getUserBySessionToken(token) : null;
        if (!user) return json(res, 200, { user: null });
        return json(res, 200, { user: { email: user.email, role: user.role } });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    (async () => {
      try {
        const cookies = cookieMap(req);
        const token = cookies && cookies.session ? cookies.session : null;
        if (token) await logoutSession(token);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=; Max-Age=0; Path=/' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  // Staff data
  if (url.pathname === '/staff/locations' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const locations = await listLocationNames();
        return json(res, 200, { locations });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff/recap' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const locationName = url.searchParams.get('locationName');
        if (!locationName) return json(res, 400, { error: 'locationName_required' });
        const recap = await getRecapForLocationName(locationName);
        return json(res, 200, { recap });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  // Tab 2: Rules configuration (per location)
  if (url.pathname === '/staff/rules' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const locationName = url.searchParams.get('locationName');
        if (!locationName) return json(res, 400, { error: 'locationName_required' });

        const saved = await getRuleConfigsForLocation(locationName);
        const savedById = new Map(saved.map((r) => [r.rule_id, r]));

        const rules = rulesCatalog.map((rule) => {
          const cfg = savedById.get(rule.rule_id) || {};
          return {
            rule_id: rule.rule_id,
            rule_name: rule.rule_name,
            definition: rule.definition,
            rationale: rule.rationale,
            params_required: !!rule.params_required,
            params_hint: rule.params_hint || null,
            active: typeof cfg.active === 'boolean' ? cfg.active : true,
            internal_notification:
              typeof cfg.internal_notification === 'boolean' ? cfg.internal_notification : false,
            asana_task_mode: cfg.asana_task_mode || 'SUMMARY',
            params: cfg.params ?? null,
          };
        });

        return json(res, 200, { rules });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff/rules' && req.method === 'PUT') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const locationName = url.searchParams.get('locationName');
        if (!locationName) return json(res, 400, { error: 'locationName_required' });

        const body = await parseBody(req);
        const incoming = Array.isArray(body.rules) ? body.rules : [];

        for (const row of incoming) {
          const ruleId = row && row.rule_id ? String(row.rule_id) : null;
          if (!ruleId) continue;

          const active = String(row.active).toUpperCase() === 'YES';
          const internalNotification = String(row.internal_notification).toUpperCase() === 'YES';
          const oneTaskPer = String(row.one_task_per_finding).toUpperCase() === 'YES';
          const asanaTaskMode = oneTaskPer ? 'PER_FINDING' : 'SUMMARY';

          const params = row.params === undefined ? null : row.params;

          await upsertRuleConfig({
            clientLocationId: locationName,
            ruleId,
            active,
            internalNotification,
            asanaTaskMode,
            params,
          });
        }

        return json(res, 200, { ok: true });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  // Staff admin endpoints remain
  if (url.pathname === '/staff-users' && req.method === 'GET') {
    (async () => {
      try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        const rows = await listStaffUsers();
        return json(res, 200, { staff_users: rows });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff-users' && req.method === 'POST') {
    (async () => {
      try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        const body = await parseBody(req);
        const created = await createStaffUser(body);
        return json(res, 200, { staff_user: created });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff-users' && req.method === 'DELETE') {
    (async () => {
      try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        const body = await parseBody(req);
        const ok = await deleteStaffUser(body);
        return json(res, 200, { ok });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  // Email workflow endpoints (existing)
  if (url.pathname === '/api/issue-token' && req.method === 'POST') {
    (async () => {
      try {
        const body = await parseBody(req);
        const token = await issueToken(body);
        return json(res, 200, { token });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/api/run' && req.method === 'POST') {
    (async () => {
      const idempotency = new IdempotencyService();
      try {
        const body = await parseBody(req);

        const key = body.idempotency_key || null;
        if (key) {
          const existing = await idempotency.get(key);
          if (existing) return json(res, 200, existing);
        }

        const run = await createRunRecord(body);
        await appendEvent(run.id, 'run_created', { ok: true });

        try {
          await runValidation(run);
          await appendEvent(run.id, 'run_completed', { ok: true });
        } catch (e) {
          await failRun(run.id, e);
          await notifyFailure(run, e);
        }

        const payload = { ok: true, run: getRun(run.id) };
        if (key) await idempotency.set(key, payload);

        return json(res, 200, payload);
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/api/approve' && req.method === 'POST') {
    (async () => {
      try {
        const body = await parseBody(req);
        const result = await approveAction(body);
        return json(res, 200, result);
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/api/rerun' && req.method === 'POST') {
    (async () => {
      try {
        const body = await parseBody(req);
        const result = await rerunAction(body);
        return json(res, 200, result);
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname.startsWith('/api/run/') && req.method === 'GET') {
    (async () => {
      try {
        const parts = url.pathname.split('/').filter(Boolean);
        const id = Number(parts[2]);
        if (!id) return json(res, 400, { error: 'id_required' });
        const run = getRun(id);
        if (!run) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { run });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  json(res, 404, { error: 'not_found' });
}

module.exports = { router };
```

---

## 2) REPLACE: web/staff.html

Copy everything in this block and paste it over your existing file.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>RDMS Payroll Validation</title>
    <style>
      :root {
        --bg: #0b1220;
        --card: #0f1a33;
        --muted: #9fb0d0;
        --text: #e9efff;
        --border: rgba(255, 255, 255, 0.12);
        --pill: rgba(255, 255, 255, 0.10);
        --ok: rgba(46, 204, 113, 0.18);
        --warn: rgba(241, 196, 15, 0.18);
        --bad: rgba(231, 76, 60, 0.18);
        --shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        background: radial-gradient(1200px 800px at 20% 0%, #17254a 0%, var(--bg) 55%);
        color: var(--text);
      }
      .wrap { max-width: 1200px; margin: 0 auto; padding: 18px 16px 44px; }
      .topbar {
        position: sticky;
        top: 0;
        z-index: 5;
        background: rgba(11, 18, 32, 0.72);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 12px 14px;
        box-shadow: var(--shadow);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        backdrop-filter: blur(10px);
      }
      .brand { font-weight: 700; letter-spacing: 0.3px; }
      .center {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .location {
        width: min(520px, 100%);
        display: flex;
        gap: 10px;
        align-items: center;
      }
      select {
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.06);
        color: var(--text);
        outline: none;
      }
      option { color: #111; }
      .userbox {
        display: flex;
        align-items: center;
        gap: 10px;
        color: var(--muted);
        font-size: 13px;
      }
      .btn {
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.06);
        color: var(--text);
        cursor: pointer;
      }
      .btn:hover { background: rgba(255, 255, 255, 0.10); }
      .btn.primary {
        background: rgba(46, 204, 113, 0.18);
        border-color: rgba(46, 204, 113, 0.35);
      }
      .tabs {
        margin-top: 14px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .tab {
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.05);
        padding: 10px 12px;
        border-radius: 12px;
        cursor: pointer;
        font-size: 13px;
        color: var(--muted);
      }
      .tab.active {
        background: rgba(46, 204, 113, 0.16);
        border-color: rgba(46, 204, 113, 0.32);
        color: var(--text);
      }
      .page {
        margin-top: 14px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: rgba(15, 26, 51, 0.55);
        box-shadow: var(--shadow);
        overflow: hidden;
      }
      .pagetitle {
        padding: 16px 18px;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 12px;
      }
      h1 { margin: 0; font-size: 18px; }
      .sub { margin: 0; color: var(--muted); font-size: 13px; }
      .content { padding: 16px 18px 18px; }
      table {
        width: 100%;
        border-collapse: collapse;
        border: 1px solid var(--border);
        border-radius: 14px;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.03);
      }
      th, td {
        padding: 10px 10px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
        font-size: 13px;
      }
      th {
        text-align: left;
        color: var(--muted);
        font-weight: 600;
        background: rgba(255, 255, 255, 0.04);
      }
      tr:last-child td { border-bottom: none; }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 12px;
      }
      .pill {
        display: inline-block;
        padding: 5px 10px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--pill);
        font-size: 12px;
      }
      .pill.ok { background: var(--ok); }
      .pill.warn { background: var(--warn); }
      .pill.bad { background: var(--bad); }
      .sectionRow td {
        background: rgba(255, 255, 255, 0.04);
        color: var(--muted);
        font-weight: 600;
      }
      .input {
        width: 100%;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.06);
        color: var(--text);
        outline: none;
      }
      .late {
        margin-top: 12px;
        padding: 12px 14px;
        border: 1px solid rgba(241, 196, 15, 0.35);
        border-radius: 14px;
        background: rgba(241, 196, 15, 0.10);
        color: var(--text);
        display: none;
      }
      .muted { color: var(--muted); }
      .loading { color: var(--muted); font-size: 13px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="topbar">
        <div class="brand">RDMS Payroll Validation</div>

        <div class="center">
          <div class="location">
            <select id="locationSelect">
              <option value="">Select a location...</option>
            </select>
          </div>
        </div>

        <div class="userbox">
          <span id="userLabel">Checking login...</span>
          <button class="btn" id="logoutBtn" type="button">Logout</button>
        </div>
      </div>

      <div class="tabs" id="tabs">
        <div class="tab active" data-tab="confirmations">Client Info Confirmations</div>
        <div class="tab" data-tab="rules">Payroll Validation Rules</div>
        <div class="tab" data-tab="excluded">Excluded Staff</div>
        <div class="tab" data-tab="reports">RDMS Manual Reporting</div>
      </div>

      <div class="page" id="page">
        <div class="pagetitle">
          <div>
            <h1 id="pageTitle">Client Info Confirmations</h1>
            <p class="sub" id="pageSub">Pick a location to load the current pay period recap.</p>
          </div>
        </div>

        <div class="content" id="content">
          <div class="loading">Select a location to load data.</div>
        </div>
      </div>

      <div class="late" id="lateNotice"></div>
    </div>

    <script>
      function escapeHtml(s) {
        return String(s || "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
      }

      function escapeAttr(s) {
        return escapeHtml(s).replaceAll("`", "&#096;");
      }

      const state = {
        tab: "confirmations",
        locations: [],
        recap: null,
        rules: null,
        rulesLocationName: null,
      };

      function setActiveTab(tab) {
        state.tab = tab;
        document.querySelectorAll(".tab").forEach(el => {
          el.classList.toggle("active", el.dataset.tab === tab);
        });

        const titleMap = {
          confirmations: "Client Info Confirmations",
          rules: "Payroll Validation Rules",
          excluded: "Excluded Staff",
          reports: "RDMS Manual Reporting",
        };

        document.getElementById("pageTitle").textContent = titleMap[tab] || "RDMS Payroll Validation";
        document.getElementById("lateNotice").style.display = "none";

        if (tab === "confirmations") {
          document.getElementById("pageSub").textContent = "Pick a location to load the current pay period recap.";
          renderConfirmations();
          return;
        }

        if (tab === "rules") {
          document.getElementById("pageSub").textContent = "Configure which rules are active for this location.";
          loadRulesForSelected();
          return;
        }

        document.getElementById("pageSub").textContent = "Coming soon.";
        document.getElementById("content").innerHTML = "<div class='muted'>Coming soon.</div>";
      }

      async function apiGet(path) {
        const resp = await fetch(path, { credentials: "include" });
        const body = await resp.json().catch(() => ({}));
        return { resp, body };
      }

      async function apiPut(path, payload) {
        const resp = await fetch(path, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(payload || {})
        });
        const body = await resp.json().catch(() => ({}));
        return { resp, body };
      }

      async function ensureLoggedIn() {
        const { resp, body } = await apiGet("/auth/me");
        if (!resp.ok) {
          window.location.href = "/auth/google";
          return;
        }
        if (!body.user) {
          window.location.href = "/auth/google";
          return;
        }
        document.getElementById("userLabel").textContent = `${body.user.email} (${body.user.role})`;
      }

      async function loadLocations() {
        const sel = document.getElementById("locationSelect");
        const { resp, body } = await apiGet("/staff/locations");
        if (!resp.ok) {
          sel.innerHTML = `<option value="">Error loading locations</option>`;
          return;
        }
        const locations = Array.isArray(body.locations) ? body.locations : [];
        state.locations = locations;

        const opts = ["<option value=\"\">Select a location...</option>"]
          .concat(locations.map((n) => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`));
        sel.innerHTML = opts.join("");
      }

      function pill(text, klass) {
        return `<span class="pill ${klass}">${text}</span>`;
      }

      function fmtDateRange(startYmd, endYmd) {
        if (!startYmd || !endYmd) return "";
        return `${startYmd} to ${endYmd}`;
      }

      function renderConfirmations() {
        const content = document.getElementById("content");
        const lateNotice = document.getElementById("lateNotice");
        lateNotice.style.display = "none";
        lateNotice.textContent = "";

        if (!state.recap) {
          content.innerHTML = "<div class='loading'>Select a location to load data.</div>";
          return;
        }

        const r = state.recap;
        const p = (r.current_pay_period || {});

        const rows = [];

        function addSection(label) {
          rows.push(`<tr class="sectionRow"><td colspan="3">${escapeHtml(label)}</td></tr>`);
        }

        function addRow(name, status, detail) {
          rows.push(
            `<tr>
              <td style="width:280px;">${escapeHtml(name)}</td>
              <td style="width:180px;">${status}</td>
              <td>${escapeHtml(detail || "")}</td>
            </tr>`
          );
        }

        const hasLate = !!r.late;
        if (hasLate) {
          lateNotice.style.display = "block";
          lateNotice.textContent = r.late_message || "Late warning";
        }

        addSection("Pay Period");
        addRow("Pay Period", pill(fmtDateRange(p.period_start, p.period_end) || "Unknown", ""), "");
        addRow("Submit Date", pill(p.period_submit_date || "Unknown", ""), "");
        addRow("Time Zone", pill(p.time_zone || "Unknown", ""), "");

        addSection("Client Info Confirmations");
        const items = Array.isArray(r.items) ? r.items : [];
        if (!items.length) {
          addRow("No items", pill("OK", "ok"), "No confirmations found.");
        } else {
          items.forEach((it) => {
            const status = (it.status || "").toUpperCase();
            const klass = status === "OK" ? "ok" : status === "WARN" ? "warn" : "bad";
            addRow(it.name || "Item", pill(status || "UNKNOWN", klass), it.detail || "");
          });
        }

        content.innerHTML = `
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              ${rows.join("")}
            </tbody>
          </table>
        `;
      }

      function yesNoSelect(value, id) {
        const v = (value || "NO").toUpperCase() === "YES" ? "YES" : "NO";
        return `
          <select data-field="${id}">
            <option value="YES" ${v === "YES" ? "selected" : ""}>YES</option>
            <option value="NO" ${v === "NO" ? "selected" : ""}>NO</option>
          </select>
        `;
      }

      function normalizeYesNo(flag) {
        return flag ? "YES" : "NO";
      }

      async function loadRulesForSelected() {
        const content = document.getElementById("content");
        const sel = document.getElementById("locationSelect");
        const name = sel.value;

        state.rules = null;
        state.rulesLocationName = name || null;

        if (!name) {
          content.innerHTML = "<div class='loading'>Select a location to load rules.</div>";
          return;
        }

        content.innerHTML = "<div class='loading'>Loading rules...</div>";

        const q = encodeURIComponent(name);
        const { resp, body } = await apiGet(`/staff/rules?locationName=${q}`);
        if (!resp.ok) {
          content.innerHTML = `<div class="muted">Rules error: ${body.error || "unknown_error"}</div>`;
          return;
        }

        state.rules = Array.isArray(body.rules) ? body.rules : [];
        renderRules();
      }

      function renderRules() {
        const content = document.getElementById("content");

        if (!state.rulesLocationName) {
          content.innerHTML = "<div class='loading'>Select a location to load rules.</div>";
          return;
        }

        if (!state.rules) {
          content.innerHTML = "<div class='loading'>Loading rules...</div>";
          return;
        }

        const header = `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;">
            <div class="muted">Location: <b style="color:var(--text)">${escapeHtml(state.rulesLocationName)}</b></div>
            <div style="display:flex;gap:10px;align-items:center;">
              <button class="btn primary" id="saveAllBtn" type="button">Save all</button>
              <button class="btn" id="reloadRulesBtn" type="button">Reload</button>
            </div>
          </div>
        `;

        const tableHead = `
          <table>
            <thead>
              <tr>
                <th style="width:140px;">Rule ID</th>
                <th style="width:220px;">Rule Name</th>
                <th style="width:170px;">Params</th>
                <th>Definition</th>
                <th style="width:140px;">Active</th>
                <th style="width:190px;">Internal Notification</th>
                <th style="width:210px;">One Task Per Finding</th>
                <th style="width:120px;">Save</th>
              </tr>
            </thead>
            <tbody>
        `;

        const rows = state.rules.map((r) => {
          const rid = escapeHtml(r.rule_id || "");
          const rname = escapeHtml(r.rule_name || "");
          const def = escapeHtml(r.definition || "");
          const paramsRequired = !!r.params_required;
          const paramsHint = escapeHtml(r.params_hint || "");
          const paramsVal = r.params === null || r.params === undefined ? "" : String(r.params);
          const paramsCell = paramsRequired
            ? `<input class="input" data-field="params" placeholder="${paramsHint || "Enter value"}" value="${escapeAttr(paramsVal)}" />`
            : `<span class="muted">None</span>`;

          const active = normalizeYesNo(!!r.active);
          const internal = normalizeYesNo(!!r.internal_notification);
          const oneTask = normalizeYesNo((r.asana_task_mode || "SUMMARY") === "PER_FINDING");

          return `
            <tr data-rule-id="${rid}">
              <td><span class="mono">${rid}</span></td>
              <td>${rname}</td>
              <td>${paramsCell}</td>
              <td>${def}</td>
              <td>${yesNoSelect(active, "active")}</td>
              <td>${yesNoSelect(internal, "internal_notification")}</td>
              <td>${yesNoSelect(oneTask, "one_task_per_finding")}</td>
              <td><button class="btn" data-action="save-row" type="button">Save</button></td>
            </tr>
          `;
        }).join("");

        const tableFoot = `
            </tbody>
          </table>
          <div class="muted" style="margin-top:10px;">
            Defaults: Active YES, Internal Notification NO, One Task Per Finding NO.
          </div>
        `;

        content.innerHTML = header + tableHead + rows + tableFoot;

        document.getElementById("saveAllBtn").addEventListener("click", saveAllRules);
        document.getElementById("reloadRulesBtn").addEventListener("click", () => loadRulesForSelected());

        content.querySelectorAll("button[data-action='save-row']").forEach((btn) => {
          btn.addEventListener("click", async (e) => {
            const tr = e.target.closest("tr");
            if (!tr) return;
            await saveRuleRow(tr);
          });
        });
      }

      function collectRowPayload(tr) {
        const ruleId = tr.getAttribute("data-rule-id");
        const getSelectVal = (field) => {
          const sel = tr.querySelector(`select[data-field='${field}']`);
          return sel ? sel.value : "NO";
        };

        const paramsInput = tr.querySelector("input[data-field='params']");
        const params = paramsInput ? paramsInput.value.trim() : null;

        return {
          rule_id: ruleId,
          active: getSelectVal("active"),
          internal_notification: getSelectVal("internal_notification"),
          one_task_per_finding: getSelectVal("one_task_per_finding"),
          params: params === "" ? null : params,
        };
      }

      async function saveRuleRow(tr) {
        const btn = tr.querySelector("button[data-action='save-row']");
        const original = btn.textContent;
        btn.textContent = "Saving...";
        btn.disabled = true;

        try {
          const payload = collectRowPayload(tr);
          const q = encodeURIComponent(state.rulesLocationName);
          const { resp, body } = await apiPut(`/staff/rules?locationName=${q}`, { rules: [payload] });
          if (!resp.ok) {
            alert(`Save failed: ${body.error || "unknown_error"}`);
            return;
          }
          btn.textContent = "Saved";
          setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 600);
        } catch (e) {
          alert(`Save failed: ${e.message || e}`);
        } finally {
          if (btn.textContent !== "Saved") {
            btn.textContent = original;
            btn.disabled = false;
          }
        }
      }

      async function saveAllRules() {
        if (!state.rulesLocationName) return;
        const content = document.getElementById("content");
        const rows = Array.from(content.querySelectorAll("tr[data-rule-id]"));
        const rules = rows.map(collectRowPayload);

        const btn = document.getElementById("saveAllBtn");
        const original = btn.textContent;
        btn.textContent = "Saving...";
        btn.disabled = true;

        try {
          const q = encodeURIComponent(state.rulesLocationName);
          const { resp, body } = await apiPut(`/staff/rules?locationName=${q}`, { rules });
          if (!resp.ok) {
            alert(`Save failed: ${body.error || "unknown_error"}`);
            return;
          }
          btn.textContent = "Saved";
          setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 800);
        } catch (e) {
          alert(`Save failed: ${e.message || e}`);
        } finally {
          if (btn.textContent !== "Saved") {
            btn.textContent = original;
            btn.disabled = false;
          }
        }
      }

      async function loadRecapForSelected() {
        const sel = document.getElementById("locationSelect");
        const name = sel.value;
        state.recap = null;
        renderConfirmations();
        if (!name) return;

        const q = encodeURIComponent(name);
        const { resp, body } = await apiGet(`/staff/recap?locationName=${q}`);
        if (!resp.ok) {
          document.getElementById("content").innerHTML = `<div class="muted">Recap error: ${body.error || "unknown_error"}</div>`;
          return;
        }
        state.recap = body.recap || null;
        renderConfirmations();
      }

      async function logout() {
        await fetch("/auth/logout", { method: "POST", credentials: "include" });
        window.location.href = "/auth/google";
      }

      document.getElementById("tabs").addEventListener("click", (e) => {
        const tab = e.target && e.target.dataset ? e.target.dataset.tab : null;
        if (!tab) return;
        setActiveTab(tab);
      });

      document.getElementById("locationSelect").addEventListener("change", () => {
        if (state.tab === "confirmations") {
          loadRecapForSelected();
          return;
        }
        if (state.tab === "rules") {
          loadRulesForSelected();
          return;
        }
        setActiveTab("confirmations");
        loadRecapForSelected();
      });

      document.getElementById("logoutBtn").addEventListener("click", logout);

      (async function boot() {
        await ensureLoggedIn();
        await loadLocations();
        setActiveTab("confirmations");
      })();
    </script>
  </body>
</html>
```

---

## Test

1. Confirm `/health` returns `{ ok: true }`

2. Go to `/staff`

* Google login
* Page loads

3. Pick a location

* Tab 1 loads as before

4. Click `Payroll Validation Rules`

* Rules list loads
* Change a few values
* Click Save (row) or Save all
* Refresh the page
* Go back to Tab 2
* The values should still be there
