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

const {
  createSessionForEmail,
  getUserBySessionToken,
  deleteSessionToken,
  upsertStaffUserAsAdminOnly,
  disableStaffUserAsAdminOnly,
  listStaffUsersAsAdminOnly,
} = require('../domain/authService');

const { listLocationNames, getRecapForLocationName } = require('../domain/airtableRecapService');

const { rulesCatalog } = require('../domain/rulesCatalog');
const { getRuleConfigsForLocation, upsertRuleConfig } = require('../domain/rulesConfigDb');

const {
  listExcludedStaffByLocation,
  createExcludedStaff,
  updateExcludedStaffById,
  softDeleteExcludedStaffById,
} = require('../domain/excludedStaffDb');

const idempotency = new IdempotencyService();

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
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

function handleError(res, err) {
  return json(res, 500, { error: err?.message || 'unknown_error' });
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie ? req.headers.cookie : '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (!k) return;
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function setSessionCookie(res, token) {
  const isProd = (process.env.PUBLIC_BASE_URL || '').startsWith('https://');
  const parts = [
    `rdms_staff_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const isProd = (process.env.PUBLIC_BASE_URL || '').startsWith('https://');
  const parts = [`rdms_staff_session=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

async function getStaffUserFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies.rdms_staff_session;
  if (!token) return null;
  return getUserBySessionToken(token);
}

async function requireStaff(req, res) {
  const user = await getStaffUserFromRequest(req);
  if (!user) {
    json(res, 401, { error: 'staff_login_required' });
    return null;
  }
  return user;
}

async function requireAdmin(req, res) {
  const user = await requireStaff(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    json(res, 403, { error: 'forbidden_admin_only' });
    return null;
  }
  return user;
}

// Google OAuth helpers
function getBaseUrl(req) {
  const envBase = (process.env.PUBLIC_BASE_URL || '').trim();
  if (envBase) return envBase.replace(/\/+$/, '');
  const host = req.headers && req.headers.host ? req.headers.host : 'localhost:3000';
  return `http://${host}`;
}

function allowedDomain() {
  return (process.env.GOOGLE_ALLOWED_DOMAIN || '').trim().toLowerCase();
}

function googleRedirectUri(req) {
  return `${getBaseUrl(req)}/auth/google/callback`;
}

function googleAuthUrl(req) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('missing_GOOGLE_CLIENT_ID');

  const redirectUri = googleRedirectUri(req);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(req, code) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId) throw new Error('missing_GOOGLE_CLIENT_ID');
  if (!clientSecret) throw new Error('missing_GOOGLE_CLIENT_SECRET');

  const redirectUri = googleRedirectUri(req);

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) throw new Error(`google_token_exchange_failed:${resp.status}`);
  return resp.json();
}

async function fetchGoogleUserInfo(accessToken) {
  const resp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`google_userinfo_failed:${resp.status}`);
  return resp.json();
}

function staffHtml() {
  // server/ is the Render root, web/ is sibling of server/
  const filePath = path.join(__dirname, '..', '..', '..', 'web', 'staff.html');
  return fs.readFileSync(filePath, 'utf8');
}

function router(req, res) {
  const url = new URL(req.url, 'http://localhost');

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

  // Start Google OAuth
  if (url.pathname === '/auth/google' && req.method === 'GET') {
    try {
      const location = googleAuthUrl(req);
      res.writeHead(302, { Location: location });
      res.end();
      return;
    } catch (e) {
      return html(res, 500, `<html><body style="font-family:Arial;padding:24px;">OAuth error: ${e.message}</body></html>`);
    }
  }

  // Google OAuth callback
  if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
    (async () => {
      try {
        const code = url.searchParams.get('code');
        if (!code) return html(res, 400, `<html><body style="font-family:Arial;padding:24px;">Missing code</body></html>`);

        const tokens = await exchangeCodeForTokens(req, code);
        const userinfo = await fetchGoogleUserInfo(tokens.access_token);

        const email = (userinfo.email || '').toLowerCase();
        const domain = email.split('@')[1] || '';
        const allowed = allowedDomain();
        if (allowed && domain !== allowed) {
          return html(res, 403, `<html><body style="font-family:Arial;padding:24px;">Access denied for domain: ${domain}</body></html>`);
        }

        const session = await createSessionForEmail(email);
        if (!session) {
          return html(res, 403, `<html><body style="font-family:Arial;padding:24px;">Access denied for email: ${email}</body></html>`);
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

  // Session info
  if (url.pathname === '/auth/me' && req.method === 'GET') {
    (async () => {
      try {
        const user = await getStaffUserFromRequest(req);
        if (!user) return json(res, 200, { user: null });
        return json(res, 200, { user: { email: user.email, role: user.role } });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  // Logout
  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    (async () => {
      try {
        const cookies = parseCookies(req);
        const token = cookies.rdms_staff_session;
        if (token) await deleteSessionToken(token);
        clearSessionCookie(res);
        return json(res, 200, { ok: true });
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

  // Excluded Staff (global ingress filter)
  // Additive only. Does not touch rule execution.
  if (url.pathname === '/staff/excluded' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const locationName = url.searchParams.get('locationName');
        if (!locationName) return json(res, 400, { error: 'locationName_required' });
        const rows = await listExcludedStaffByLocation(locationName);
        return json(res, 200, { excluded: rows });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff/excluded' && req.method === 'POST') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const body = await parseBody(req);

        const row = await createExcludedStaff({
          location_name: body.location_name,
          toast_employee_id: body.toast_employee_id,
          employee_name: body.employee_name,
          reason: body.reason,
          effective_from: body.effective_from,
          effective_to: body.effective_to,
          notes: body.notes,
          active: body.active,
        });

        return json(res, 200, { excluded: row });
      } catch (e) {
        // Common input errors return 400
        const msg = String(e.message || '');
        if (
          msg === 'location_name_required' ||
          msg === 'toast_employee_id_required' ||
          msg === 'reason_required'
        ) {
          return json(res, 400, { error: msg });
        }
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname.startsWith('/staff/excluded/') && req.method === 'PUT') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const parts = url.pathname.split('/').filter(Boolean);
        const id = Number(parts[2]);
        if (!id) return json(res, 400, { error: 'id_required' });

        const body = await parseBody(req);

        // toast_employee_id must be read-only once saved
        if (body.toast_employee_id !== undefined) {
          return json(res, 400, { error: 'toast_employee_id_read_only' });
        }
        if (body.location_name !== undefined) {
          return json(res, 400, { error: 'location_name_read_only' });
        }

        const row = await updateExcludedStaffById(id, {
          employee_name: body.employee_name,
          reason: body.reason,
          effective_from: body.effective_from,
          effective_to: body.effective_to,
          notes: body.notes,
          active: body.active,
        });

        if (!row) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { excluded: row });
      } catch (e) {
        const msg = String(e.message || '');
        if (msg === 'id_invalid' || msg === 'reason_required') {
          return json(res, 400, { error: msg });
        }
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname.startsWith('/staff/excluded/') && req.method === 'DELETE') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const parts = url.pathname.split('/').filter(Boolean);
        const id = Number(parts[2]);
        if (!id) return json(res, 400, { error: 'id_required' });

        const row = await softDeleteExcludedStaffById(id);
        if (!row) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { excluded: row });
      } catch (e) {
        const msg = String(e.message || '');
        if (msg === 'id_invalid') {
          return json(res, 400, { error: msg });
        }
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

        const { byRuleId, defaults } = await getRuleConfigsForLocation(locationName);

        const rules = rulesCatalog.map((rule) => {
          const cfg = byRuleId[rule.rule_id] || {};
          return {
            rule_id: rule.rule_id,
            rule_name: rule.rule_name,
            definition: rule.definition,
            rationale: rule.rationale,
            params_required: !!rule.params_required,
            params_hint: rule.params_hint || null,
            active: typeof cfg.active === 'boolean' ? cfg.active : defaults.active,
            internal_notification:
              typeof cfg.internal_notification === 'boolean' ? cfg.internal_notification : defaults.internal_notification,
            asana_task_mode: cfg.asana_task_mode || defaults.asana_task_mode,
            params: cfg.params ?? defaults.params,
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

          await upsertRuleConfig(locationName, ruleId, {
            active,
            internal_notification: internalNotification,
            asana_task_mode: asanaTaskMode,
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

  // Admin: staff user management
  if (url.pathname === '/admin/staff-users' && req.method === 'GET') {
    (async () => {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      try {
        const users = await listStaffUsersAsAdminOnly(admin.email);
        return json(res, 200, { users });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/admin/staff-users' && req.method === 'POST') {
    (async () => {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      try {
        const body = await parseBody(req);
        const email = (body.email || '').toLowerCase();
        const role = body.role || 'staff';
        if (!email) return json(res, 400, { error: 'email_required' });
        const user = await upsertStaffUserAsAdminOnly(admin.email, email, role);
        return json(res, 200, { user });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/admin/staff-users/disable' && req.method === 'POST') {
    (async () => {
      const admin = await requireAdmin(req, res);
      if (!admin) return;
      try {
        const body = await parseBody(req);
        const email = (body.email || '').toLowerCase();
        if (!email) return json(res, 400, { error: 'email_required' });
        await disableStaffUserAsAdminOnly(admin.email, email);
        return json(res, 200, { ok: true });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  // Email workflow endpoints
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

  return json(res, 404, { error: 'not_found' });
}

module.exports = { router };
