// server/src/api/routes.js

const fetch = require('node-fetch');

const { issueToken } = require('../domain/tokenService');
const { createRunRecord, appendEvent, failRun, getRun } = require('../domain/runManager');
const { approveAction, rerunAction } = require('../domain/approvalService');
const { IdempotencyService } = require('../domain/idempotencyService');
const { notifyFailure } = require('../domain/failureService');
const { runValidation } = require('../domain/validationEngine');

const {
  createClientLocation,
  listClientLocations,
  updateClientLocation,
  deleteClientLocation,
} = require('../domain/clientLocationService');

const {
  listExclusionsForLocation,
  createExclusion,
  updateExclusion,
  deleteExclusion,
} = require('../domain/exclusionConfigService');

const {
  getRuleConfigsForLocation,
  setRuleConfig,
  deleteRuleConfig,
} = require('../domain/ruleConfigService');

const {
  createSessionForEmail,
  getUserBySessionToken,
  deleteSessionToken,
  upsertStaffUserAsAdminOnly,
  disableStaffUserAsAdminOnly,
  listStaffUsersAsAdminOnly,
} = require('../domain/authService');

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
      } catch (e) {
        resolve({});
      }
    });
  });
}

function handleError(res, err) {
  if (err && err.message === 'persistence_store_corrupt') {
    return json(res, 500, { error: 'persistence_store_corrupt', backup: err.backup || null });
  }
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
  const parts = [
    `rdms_staff_session=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
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
    json(res, 403, { error: 'admin_only' });
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

  const jsonBody = await resp.json();
  if (!resp.ok) {
    throw new Error(`google_token_exchange_failed:${resp.status}`);
  }
  return jsonBody;
}

async function fetchGoogleUserInfo(accessToken) {
  const resp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await resp.json();
  if (!resp.ok) throw new Error(`google_userinfo_failed:${resp.status}`);
  return body;
}

function router(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') return json(res, 200, { ok: true });

  // -----------------------
  // Staff Auth (Google)
  // -----------------------
  if (url.pathname === '/auth/google' && req.method === 'GET') {
    try {
      const redirect = googleAuthUrl(req);
      res.writeHead(302, { Location: redirect });
      res.end();
      return;
    } catch (e) {
      return handleError(res, e);
    }
  }

  if (url.pathname === '/auth/google/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    if (!code) return html(res, 400, '<html><body style="font-family:Arial;padding:24px;">Missing code.</body></html>');

    (async () => {
      try {
        const tokens = await exchangeCodeForTokens(req, code);
        const userInfo = await fetchGoogleUserInfo(tokens.access_token);

        const email = (userInfo.email || '').trim().toLowerCase();
        const domain = allowedDomain();
        if (!email) throw new Error('google_missing_email');
        if (domain && !email.endsWith(`@${domain}`)) throw new Error('forbidden_domain');
        if (userInfo.email_verified === false) throw new Error('email_not_verified');

        const session = await createSessionForEmail(email);
        if (!session) {
          // Staff must be pre-approved in staff_users
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

        // For now, send them to a simple placeholder page.
        // We will replace this with the real staff console later.
        return html(
          res,
          200,
          `<html><body style="font-family:Arial;padding:24px;">
            Logged in as <b>${session.user.email}</b> (${session.user.role}).<br/><br/>
            Next: we will build the Staff Console UI.
          </body></html>`,
        );
      } catch (e) {
        return html(res, 500, `<html><body style="font-family:Arial;padding:24px;">Login failed: ${e.message}</body></html>`);
      }
    })();
    return;
  }

  if (url.pathname === '/auth/me' && req.method === 'GET') {
    (async () => {
      const user = await getStaffUserFromRequest(req);
      if (!user) return json(res, 200, { user: null });
      return json(res, 200, { user });
    })();
    return;
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    (async () => {
      const cookies = parseCookies(req);
      if (cookies.rdms_staff_session) await deleteSessionToken(cookies.rdms_staff_session);
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    })();
    return;
  }

  // -----------------------
  // Staff Admin: manage staff users
  // -----------------------
  if (url.pathname === '/staff-users' && req.method === 'GET') {
    (async () => {
      try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        const rows = await listStaffUsersAsAdminOnly(admin.email);
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
        const created = await upsertStaffUserAsAdminOnly(admin.email, body.email, body.role);
        return json(res, 201, { staff_user: created });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff-users/disable' && req.method === 'POST') {
    (async () => {
      try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        const body = await parseBody(req);
        await disableStaffUserAsAdminOnly(admin.email, body.email);
        return json(res, 200, { ok: true });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  // -----------------------
  // Tokens
  // -----------------------
  if (url.pathname === '/tokens/issue' && req.method === 'POST') {
    parseBody(req).then((body) => {
      try {
        const token = issueToken({
          action: body.action,
          runId: body.runId,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          ttlMinutes: body.ttlMinutes || 60,
        });
        json(res, 200, { token });
      } catch (e) {
        json(res, 400, { error: e.message });
      }
    });
    return;
  }

  // -----------------------
  // Client Locations (staff only)
  // -----------------------
  if (url.pathname === '/client-locations' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const activeOnly = url.searchParams.get('activeOnly');
        const rows = listClientLocations({
          activeOnly: activeOnly === null ? true : activeOnly !== 'false',
        });
        return json(res, 200, { client_locations: rows });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/client-locations' && req.method === 'POST') {
    (async () => {
      const user = await requireAdmin(req, res);
      if (!user) return;
      const body = await parseBody(req);
      try {
        const row = createClientLocation(body);
        return json(res, 201, { client_location: row });
      } catch (e) {
        if (e && e.message === 'persistence_store_corrupt') return handleError(res, e);
        return json(res, 400, { error: e.message });
      }
    })();
    return;
  }

  if (url.pathname.startsWith('/client-locations/') && req.method === 'PUT') {
    (async () => {
      const user = await requireAdmin(req, res);
      if (!user) return;
      const id = url.pathname.split('/')[2];
      const body = await parseBody(req);
      try {
        const row = updateClientLocation(id, body);
        if (!row) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { client_location: row });
      } catch (e) {
        if (e && e.message === 'persistence_store_corrupt') return handleError(res, e);
        return json(res, 400, { error: e.message });
      }
    })();
    return;
  }

  if (url.pathname.startsWith('/client-locations/') && req.method === 'DELETE') {
    (async () => {
      const user = await requireAdmin(req, res);
      if (!user) return;
      try {
        const id = url.pathname.split('/')[2];
        const ok = deleteClientLocation(id);
        return json(res, 200, { deleted: ok === true });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  // -----------------------
  // Rule Configs (staff only)
  // -----------------------
  if (url.pathname === '/rule-configs' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const clientLocationId = url.searchParams.get('clientLocationId');
        if (!clientLocationId) return json(res, 400, { error: 'clientLocationId_required' });
        const rows = getRuleConfigsForLocation(clientLocationId);
        return json(res, 200, { rule_configs: rows });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/rule-configs' && req.method === 'PUT') {
    (async () => {
      const user = await requireAdmin(req, res);
      if (!user) return;
      const clientLocationId = url.searchParams.get('clientLocationId');
      const ruleCode = url.searchParams.get('ruleCode');
      if (!clientLocationId) return json(res, 400, { error: 'clientLocationId_required' });
      if (!ruleCode) return json(res, 400, { error: 'ruleCode_required' });

      const body = await parseBody(req);
      try {
        const row = setRuleConfig(clientLocationId, ruleCode, body);
        return json(res, 200, { rule_config: row });
      } catch (e) {
        if (e && e.message === 'persistence_store_corrupt') return handleError(res, e);
        return json(res, 400, { error: e.message });
      }
    })();
    return;
  }

  if (url.pathname === '/rule-configs' && req.method === 'DELETE') {
    (async () => {
      const user = await requireAdmin(req, res);
      if (!user) return;
      try {
        const clientLocationId = url.searchParams.get('clientLocationId');
        const ruleCode = url.searchParams.get('ruleCode');
        if (!clientLocationId) return json(res, 400, { error: 'clientLocationId_required' });
        if (!ruleCode) return json(res, 400, { error: 'ruleCode_required' });
        const ok = deleteRuleConfig(clientLocationId, ruleCode);
        return json(res, 200, { deleted: ok === true });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  // -----------------------
  // Exclusions (staff only)
  // -----------------------
  if (url.pathname === '/exclusions' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const clientLocationId = url.searchParams.get('clientLocationId');
        if (!clientLocationId) return json(res, 400, { error: 'clientLocationId_required' });
        const rows = listExclusionsForLocation(clientLocationId);
        return json(res, 200, { exclusions: rows });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/exclusions' && req.method === 'POST') {
    (async () => {
      const user = await requireAdmin(req, res);
      if (!user) return;
      const clientLocationId = url.searchParams.get('clientLocationId');
      if (!clientLocationId) return json(res, 400, { error: 'clientLocationId_required' });
      const body = await parseBody(req);
      try {
        const row = createExclusion(clientLocationId, body);
        return json(res, 201, { exclusion: row });
      } catch (e) {
        if (e && e.message === 'persistence_store_corrupt') return handleError(res, e);
        return json(res, 400, { error: e.message });
      }
    })();
    return;
  }

  if (url.pathname === '/exclusions' && req.method === 'PUT') {
    (async () => {
      const user = await requireAdmin(req, res);
      if (!user) return;
      const id = url.searchParams.get('id');
      if (!id) return json(res, 400, { error: 'id_required' });
      const body = await parseBody(req);
      try {
        const row = updateExclusion(id, body);
        if (!row) return json(res, 404, { error: 'not_found' });
        return json(res, 200, { exclusion: row });
      } catch (e) {
        if (e && e.message === 'persistence_store_corrupt') return handleError(res, e);
        return json(res, 400, { error: e.message });
      }
    })();
    return;
  }

  if (url.pathname === '/exclusions' && req.method === 'DELETE') {
    (async () => {
      const user = await requireAdmin(req, res);
      if (!user) return;
      try {
        const id = url.searchParams.get('id');
        if (!id) return json(res, 400, { error: 'id_required' });
        const ok = deleteExclusion(id);
        return json(res, 200, { deleted: ok === true });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  // -----------------------
  // Validation (public, used by ops email flow)
  // -----------------------
  if (url.pathname === '/validate' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      try {
        const run = createRunRecord({
          clientLocationId: body.clientLocationId,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
        });

        appendEvent(run, 'validation_requested', { at: new Date().toISOString() });

        try {
          const result = await runValidation(run);
          appendEvent(run, 'validation_completed', { ok: true });
          return json(res, 200, { run, result });
        } catch (e) {
          failRun(run, e);
          notifyFailure({ step: 'validation', error: e.message, runId: run.id });
          return json(res, 500, { error: e.message, run_id: run.id });
        }
      } catch (e) {
        notifyFailure({ step: 'validation', error: e.message, runId: null });
        return json(res, 500, { error: e.message });
      }
    });
    return;
  }

  // -----------------------
  // Run (read-only convenience, staff only)
  // -----------------------
  if (url.pathname === '/run' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const id = url.searchParams.get('id');
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

  // -----------------------
  // Idempotency (public utility)
  // -----------------------
  if (url.pathname === '/idempotency/check' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      const exists = idempotency.check(body.scope, body.key);
      if (exists) return json(res, 200, { reused: true });
      idempotency.record(body.scope, body.key);
      json(res, 200, { reused: false });
    });
    return;
  }

  // -----------------------
  // Approve / Rerun (public, used by email CTA links)
  // -----------------------
  if (url.pathname === '/approve' && req.method === 'GET') {
    const tokenId = url.searchParams.get('token');
    if (!tokenId) {
      notifyFailure({ step: 'approve', error: 'missing_token', runId: null });
      return html(res, 400, '<html><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;">Missing token.</body></html>');
    }

    approveAction(tokenId)
      .then((result) => {
        const statusCode = result && result.ok === false ? 400 : 200;
        html(res, statusCode, result.html || '');
      })
      .catch((e) => {
        notifyFailure({ step: 'approve', error: e?.message || 'approve_failed', runId: null });
        html(res, 500, '<html><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;">Server error.</body></html>');
      });

    return;
  }

  if (url.pathname === '/rerun' && req.method === 'GET') {
    const tokenId = url.searchParams.get('token');
    if (!tokenId) {
      notifyFailure({ step: 'rerun', error: 'missing_token', runId: null });
      return html(res, 400, '<html><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;">Missing token.</body></html>');
    }

    rerunAction(tokenId)
      .then((result) => {
        const statusCode = result && result.ok === false ? 400 : 200;
        html(res, statusCode, result.html || '');
      })
      .catch((e) => {
        notifyFailure({ step: 'rerun', error: e?.message || 'rerun_failed', runId: null });
        html(res, 500, '<html><body style="font-family:Arial,Helvetica,sans-serif;padding:24px;">Server error.</body></html>');
      });

    return;
  }

  json(res, 404, { error: 'not_found' });
}

module.exports = { router };
