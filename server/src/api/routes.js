// server/src/api/routes.js

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const { issueToken } = require('../domain/tokenService');
const { createRun, appendEvent, updateRun, getRunById } = require('../domain/runManager');
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

const {
  listLocationNames,
  getRecapForLocationName,
  getPayPeriodSelectorForLocationName,
  getActivePayrollDashboardRows,
  getCommunicationRecipientsForLocationName,
} = require('../domain/airtableRecapService');
const { searchToastEmployeesForLocation } = require('../domain/toastBarrioProofService');
const { fetchOriginalToastPayPeriodData } = require('../domain/toastOriginalPayPeriodService');
const {
  parseCsv,
  normalizeUploadedRow,
  normalizeApiRow,
  buildStableKey,
  compareRows,
  saveUploadedBaseline,
  getLatestBaseline,
  clearBaseline,
} = require('../domain/toastPayrollBaselineService');

const { rulesCatalog } = require('../domain/rulesCatalog');
const { getRuleConfigsForLocation, upsertRuleConfig, upsertClientRuleConfig } = require('../domain/rulesConfigDb');
const {
  listCommunicationRecipientSettings,
  upsertCommunicationRecipientSetting,
} = require('../domain/communicationSetupDb');

const {
  listExcludedStaffByLocation,
  createExcludedStaff,
  updateExcludedStaffById,
  softDeleteExcludedStaffById,
} = require('../domain/excludedStaffDb');
const { buildOutcome, saveOutcome } = require('../domain/outcomeService');
const { buildArtifacts } = require('../domain/artifactService');

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

  if (url.pathname === '/staff/pay-period-selector' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const locationName = url.searchParams.get('locationName');
        if (!locationName) return json(res, 400, { error: 'locationName_required' });
        const selector = await getPayPeriodSelectorForLocationName(locationName);
        return json(res, 200, { selector });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff/payroll-dashboard-active' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const dashboard = await getActivePayrollDashboardRows();
        return json(res, 200, dashboard);
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff/toast-original-pay-period' && req.method === 'POST') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const body = await parseBody(req);
        const locationName = String(body.location_name || '').trim();
        const periodStart = String(body.period_start || '').trim();
        const periodEnd = String(body.period_end || '').trim();
        const includeDebug = body.debug_toast_mapping === true;
        if (!locationName || !periodStart || !periodEnd) {
          return json(res, 400, { error: 'missing_required_fields' });
        }

        const data = await fetchOriginalToastPayPeriodData({
          locationName,
          periodStart,
          periodEnd,
          includeDebug,
        });

        const baseline = await getLatestBaseline({ locationName, periodStart, periodEnd });
        let comparison = null;
        if (baseline) {
          const apiNormalizedRows = (Array.isArray(data?.rows) ? data.rows : []).map((row) =>
            normalizeApiRow(row, {
              location_name: locationName,
              period_start: periodStart,
              period_end: periodEnd,
            })
          );
          const baselineNormalizedRows = baseline.rows.map((r) => r.normalized);
          comparison = {
            upload: {
              id: baseline.upload.id,
              uploaded_by: baseline.upload.uploaded_by,
              uploaded_at: baseline.upload.uploaded_at,
              file_name: baseline.upload.file_name,
            },
            ...compareRows(apiNormalizedRows, baselineNormalizedRows),
            uploaded_csv_rows: baselineNormalizedRows,
          };
        }

        return json(res, 200, { data, comparison });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }



  if (url.pathname === '/staff/toast-original-pay-period/baseline' && req.method === 'POST') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const body = await parseBody(req);
        const locationName = String(body.location_name || '').trim();
        const periodStart = String(body.period_start || '').trim();
        const periodEnd = String(body.period_end || '').trim();
        const rawCsv = String(body.raw_csv || '');
        const fileName = String(body.file_name || '').trim();

        if (!locationName || !periodStart || !periodEnd || !rawCsv.trim()) {
          return json(res, 400, { error: 'missing_required_fields' });
        }

        const parsed = parseCsv(rawCsv);
        if (!parsed.headers.length) return json(res, 400, { error: 'invalid_csv_headers' });

        const normalizedRows = parsed.rows.map((rawRow) => {
          const normalized = normalizeUploadedRow(rawRow, {
            location_name: locationName,
            period_start: periodStart,
            period_end: periodEnd,
          });
          return {
            raw: rawRow,
            normalized,
            stable_key: buildStableKey(normalized),
          };
        });

        const upload = await saveUploadedBaseline({
          locationName,
          periodStart,
          periodEnd,
          uploadedBy: user.email,
          fileName,
          rawCsv,
          csvRows: normalizedRows,
        });

        return json(res, 200, {
          upload,
          headers: parsed.headers,
          row_count: normalizedRows.length,
          normalized_rows: normalizedRows.map((row) => row.normalized),
        });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff/toast-original-pay-period/baseline' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const locationName = String(url.searchParams.get('locationName') || '').trim();
        const periodStart = String(url.searchParams.get('periodStart') || '').trim();
        const periodEnd = String(url.searchParams.get('periodEnd') || '').trim();
        if (!locationName || !periodStart || !periodEnd) {
          return json(res, 400, { error: 'missing_required_fields' });
        }

        const baseline = await getLatestBaseline({ locationName, periodStart, periodEnd });
        if (!baseline) return json(res, 200, { baseline: null });

        return json(res, 200, {
          baseline: {
            upload: baseline.upload,
            row_count: baseline.rows.length,
            normalized_rows: baseline.rows.map((row) => row.normalized),
            raw_rows: baseline.rows.map((row) => row.raw),
          },
        });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff/toast-original-pay-period/baseline' && req.method === 'DELETE') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const body = await parseBody(req);
        const locationName = String(body.location_name || '').trim();
        const periodStart = String(body.period_start || '').trim();
        const periodEnd = String(body.period_end || '').trim();
        if (!locationName || !periodStart || !periodEnd) {
          return json(res, 400, { error: 'missing_required_fields' });
        }

        const result = await clearBaseline({ locationName, periodStart, periodEnd });
        return json(res, 200, {
          ok: true,
          deleted_upload_count: result.deleted_upload_count,
        });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff/validation-outcome/run' && req.method === 'POST') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const body = await parseBody(req);
        const locationName = String(body.location_name || '').trim();
        const periodStart = String(body.period_start || '').trim();
        const periodEnd = String(body.period_end || '').trim();
        const reportOnly = body.report_only === true;
        const suppressAsana = body.suppress_asana === true;
        const createAsanaTasks = body.create_asana_tasks === true;
        if (!locationName || !periodStart || !periodEnd) {
          return json(res, 400, { error: 'missing_required_fields' });
        }

        const run = await createRun({
          client_location_id: locationName,
          period_start: periodStart,
          period_end: periodEnd,
          payload: {
            source: reportOnly ? 'staff_payroll_recap_report' : 'staff_outcome_tab',
            selected_period: {
              period_start: periodStart,
              period_end: periodEnd,
              validation_date: body.validation_date || null,
            },
            requested_by: user.email,
            report_only: reportOnly,
            suppress_asana: suppressAsana,
            create_asana_tasks: createAsanaTasks,
          },
          status: 'running',
        });

        appendEvent(run, 'staff_outcome_run_created', { requested_by: user.email });
        await updateRun(run.id, { events: run.events });

        const excluded = await listExcludedStaffByLocation(locationName);
        const activeExcluded = (Array.isArray(excluded) ? excluded : []).filter((x) => x && x.active);

        const { byRuleId, defaults } = await getRuleConfigsForLocation(locationName);
        const activeRuleIds = rulesCatalog
          .filter((rule) => {
            const cfg = byRuleId[rule.rule_id] || {};
            const isActive = typeof cfg.active === 'boolean' ? cfg.active : defaults.active;
            return isActive === true;
          })
          .map((rule) => rule.rule_id);

        const selector = await getPayPeriodSelectorForLocationName(locationName);
        const selectorPeriods = [
          ...(Array.isArray(selector?.prior_pay_periods) ? selector.prior_pay_periods : []),
          selector?.current_pay_period || null,
          selector?.next_pay_period || null,
        ]
          .filter((p) => p && p.start_date && p.end_date)
          .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));

        const selectedIndex = selectorPeriods.findIndex(
          (p) => String(p.start_date) === periodStart && String(p.end_date) === periodEnd
        );
        const comparisonPeriods =
          selectedIndex > 0
            ? selectorPeriods
                .slice(Math.max(0, selectedIndex - 6), selectedIndex)
                .map((p) => ({
                  period_start: p.start_date,
                  period_end: p.end_date,
                }))
            : [];

        const validationResult = await runValidation({
          run,
          context: {
            periodStart,
            periodEnd,
            active_rule_ids: activeRuleIds,
            comparison_periods: comparisonPeriods,
          },
          exclusions: activeExcluded,
          ruleCatalog: rulesCatalog,
        });
        const findings = Array.isArray(validationResult?.findings) ? validationResult.findings : [];
        const artifacts = buildArtifacts({ run, policySnapshot: {} });
        const outcome = await buildOutcome(run, findings, artifacts, null);
        outcome.summary = {
          ...(outcome.summary || {}),
          excluded_staff_count: activeExcluded.length,
          active_rules_count: activeRuleIds.length,
          comparison_periods_used: comparisonPeriods.length,
        };
        outcome.excluded_staff = activeExcluded.map((row) => ({
          id: row.id,
          toast_employee_id: row.toast_employee_id,
          employee_name: row.employee_name,
          reason: row.reason,
          notes: row.notes,
          active: row.active,
        }));
        outcome.validation_context = {
          selected_period: {
            period_start: periodStart,
            period_end: periodEnd,
            validation_date: body.validation_date || null,
          },
          comparison_periods: comparisonPeriods,
          active_rule_ids: activeRuleIds,
          data_sources: validationResult?.data_sources || [],
        };

        const savedOutcome = await saveOutcome(run.id, outcome);

        appendEvent(run, 'staff_outcome_saved', {
          outcome_status: savedOutcome?.status || 'completed',
          findings_count: Array.isArray(savedOutcome?.findings) ? savedOutcome.findings.length : 0,
        });
        await updateRun(run.id, { status: 'completed', events: run.events });

        const latestRun = await getRunById(run.id);
        return json(res, 200, { ok: true, run: latestRun, outcome: savedOutcome });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff/toast-employees' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const locationName = url.searchParams.get('locationName');
        const q = url.searchParams.get('q');
        const limit = Number(url.searchParams.get('limit') || 10);
        if (!locationName) return json(res, 400, { error: 'locationName_required' });
        const result = await searchToastEmployeesForLocation(locationName, q, limit);
        if (!result.ok) {
          const code = String(result.error || '');
          if (code === 'locationName_required') return json(res, 400, { error: code });
          return json(res, 422, { error: code || 'toast_search_failed' });
        }
        return json(res, 200, {
          employees: result.results,
          endpointUsed: result.endpointUsed,
        });
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
            include_in_preview_recap_report:
              typeof cfg.include_in_preview_recap_report === 'boolean'
                ? cfg.include_in_preview_recap_report
                : defaults.include_in_preview_recap_report,
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
          const includeInPreviewRecapReport = String(row.include_in_preview_recap_report).toUpperCase() === 'YES';
          const asanaTaskMode = oneTaskPer ? 'PER_FINDING' : 'SUMMARY';

          const params = row.params === undefined ? null : row.params;

          await upsertRuleConfig(locationName, ruleId, {
            active,
            internal_notification: internalNotification,
            asana_task_mode: asanaTaskMode,
            include_in_preview_recap_report: includeInPreviewRecapReport,
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

  // Tab 2b: Client validation rules configuration (per location)
  if (url.pathname === '/staff/client-rules' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const locationName = url.searchParams.get('locationName');
        if (!locationName) return json(res, 400, { error: 'locationName_required' });

        const { byRuleId, defaults } = await getRuleConfigsForLocation(locationName);

        const rules = rulesCatalog.map((rule) => {
          const cfg = byRuleId[rule.rule_id] || {};
          const internalActive = typeof cfg.active === 'boolean' ? cfg.active : defaults.active;
          return {
            rule_id: rule.rule_id,
            rule_name: rule.rule_name,
            definition: rule.definition,
            rationale: rule.rationale,
            params_required: !!rule.params_required,
            params_hint: rule.params_hint || null,
            params: cfg.params ?? defaults.params,
            client_active: typeof cfg.client_active === 'boolean' ? cfg.client_active : internalActive,
            client_include_to_email:
              typeof cfg.client_include_to_email === 'boolean' ? cfg.client_include_to_email : true,
          };
        });

        return json(res, 200, { rules });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff/client-rules' && req.method === 'PUT') {
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

          const clientActive = String(row.client_active).toUpperCase() === 'YES';
          const clientIncludeToEmail = String(row.client_include_to_email).toUpperCase() === 'YES';
          const params = row.params === undefined ? null : row.params;

          await upsertClientRuleConfig(locationName, ruleId, {
            client_active: clientActive,
            client_include_to_email: clientIncludeToEmail,
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

  if (url.pathname === '/staff/communication-setup' && req.method === 'GET') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const locationName = String(url.searchParams.get('locationName') || '').trim();
        if (!locationName) return json(res, 400, { error: 'locationName_required' });

        const source = await getCommunicationRecipientsForLocationName(locationName);
        const persistedByEmail = await listCommunicationRecipientSettings(locationName);

        const rows = (Array.isArray(source.recipients) ? source.recipients : []).map((email) => {
          const normalizedEmail = String(email || '').trim().toLowerCase();
          const saved = persistedByEmail[normalizedEmail] || null;
          return {
            email,
            send_validation_email: saved ? saved.send_validation_email === true : true,
            updated_at: saved ? saved.updated_at : null,
            updated_by: saved ? saved.updated_by : null,
          };
        });

        return json(res, 200, { location_name: locationName, recipients: rows });
      } catch (e) {
        return handleError(res, e);
      }
    })();
    return;
  }

  if (url.pathname === '/staff/communication-setup' && req.method === 'PUT') {
    (async () => {
      const user = await requireStaff(req, res);
      if (!user) return;
      try {
        const locationName = String(url.searchParams.get('locationName') || '').trim();
        if (!locationName) return json(res, 400, { error: 'locationName_required' });

        const body = await parseBody(req);
        const email = String(body.email || '').trim();
        const rawValue = body.send_validation_email;
        const normalizedValue =
          typeof rawValue === 'boolean'
            ? rawValue
            : String(rawValue || '').trim().toUpperCase() === 'YES';

        const saved = await upsertCommunicationRecipientSetting({
          locationName,
          email,
          sendValidationEmail: normalizedValue,
          updatedBy: user.email,
        });

        return json(res, 200, { recipient: saved });
      } catch (e) {
        const msg = String(e.message || '');
        if (msg === 'location_name_required' || msg === 'email_required') {
          return json(res, 400, { error: msg });
        }
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

        const run = await createRun({
          client_location_id: body.client_location_id,
          period_start: body.period_start,
          period_end: body.period_end,
          payload: body.payload || null,
          status: 'running',
        });
        appendEvent(run, 'run_created', { ok: true });
        await updateRun(run.id, { events: run.events });

        try {
          await runValidation({ run });
          appendEvent(run, 'run_completed', { ok: true });
          await updateRun(run.id, { status: 'completed', events: run.events });
        } catch (e) {
          appendEvent(run, 'run_failed', { error: e?.message || 'run_failed' });
          await updateRun(run.id, { status: 'failed', events: run.events });
          await notifyFailure(run, e);
        }

        const latestRun = await getRunById(run.id);
        const payload = { ok: true, run: latestRun };
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
        const run = await getRunById(id);
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
