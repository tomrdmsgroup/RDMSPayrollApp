// server/src/api/routes.js

const fs = require('fs');
const path = require('path');

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
  getStaffUserFromRequest,
  setSessionCookie,
} = require('../domain/sessionService');

const { listLocationNames, getRecapForLocationName } = require('../domain/airtableRecapService');

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
    return '<html><body style="font-family:Arial;padding:24px;">Missing staff.html</body></html>';
  }
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

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(302, { Location: '/staff' });
    res.end();
    return;
  }

  if (url.pathname === '/staff' && req.method === 'GET') {
    (async () => {
      const user = await getStaffUserFromRequest(req);
      if (!user) {
        res.writeHead(302, { Location: '/auth/google' });
        res.end();
        return;
      }
      return html(res, 200, readStaffHtml());
    })();
    return;
  }

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
            internal_notification: typeof cfg.internal_notification === 'boolean' ? cfg.internal_notification : false,
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
