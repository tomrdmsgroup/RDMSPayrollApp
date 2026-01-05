// server/src/domain/approvalService.js
//
// Step 2 behavior rules
// 1) Approval is final for a location + pay period.
// 2) Once any approval exists for that location + pay period, reruns are blocked.
// 3) Approve always succeeds (or no-ops as "already approved") even if rerun was clicked earlier.
// 4) On first approval for the pay period, create ONE Asana task using routing from Airtable Vitals.
//    (Project GUID + Inbox Section GUID). No internal email.

const { query } = require('./db');
const { validateToken, markTokenUsed } = require('./tokenService');
const { getRunById, updateRun, appendEvent } = require('./runManager');
const { getOutcome, updateOutcome } = require('./outcomeService');
const { fetchVitalsSnapshot } = require('../providers/vitalsProvider');
const { resolveAsanaRoute } = require('./asanaTaskService');
const { createTask } = require('../providers/asanaProvider');
const { notifyFailure } = require('./failureService');

function nowIso() {
  return new Date().toISOString();
}

function formatPacific(isoString) {
  try {
    const d = isoString ? new Date(isoString) : new Date();
    return d.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch (_) {
    return '';
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function htmlPage(title, heading, lines) {
  const safeTitle = escapeHtml(title);
  const safeHeading = escapeHtml(heading);
  const body = (Array.isArray(lines) ? lines : [])
    .map((t) => `<p style="margin:0 0 12px 0;">${escapeHtml(t)}</p>`)
    .join('');

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
  </head>
  <body style="margin:0; padding:24px; background:#f3f4f6; font-family: Arial, Helvetica, sans-serif;">
    <div style="max-width:720px; margin:0 auto; background:#ffffff; border-radius:12px; padding:24px; box-shadow:0 2px 10px rgba(0,0,0,0.06);">
      <h1 style="margin:0 0 12px 0; font-size:20px; color:#111827;">${safeHeading}</h1>
      <div style="font-size:14px; color:#111827; line-height:1.6;">
        ${body}
      </div>
      <div style="margin-top:16px; font-size:12px; color:#6b7280;">
        If you reached this page by mistake, close this tab.
      </div>
    </div>
  </body>
</html>`;
}

async function getPeriodApproval(client_location_id, period_start, period_end) {
  const r = await query(
    `SELECT approved_run_id, approved_at
     FROM ops_period_approvals
     WHERE client_location_id = $1 AND period_start = $2 AND period_end = $3
     LIMIT 1`,
    [String(client_location_id || ''), String(period_start || ''), String(period_end || '')],
  );

  if (!r.rows.length) return null;
  return r.rows[0] || null;
}

// Returns true only if we inserted (first approval wins).
async function insertPeriodApproval(client_location_id, period_start, period_end, approved_run_id, approved_token) {
  const r = await query(
    `INSERT INTO ops_period_approvals
      (client_location_id, period_start, period_end, approved_run_id, approved_at, approved_token, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), $5, NOW(), NOW())
     ON CONFLICT (client_location_id, period_start, period_end) DO NOTHING
     RETURNING id`,
    [
      String(client_location_id || ''),
      String(period_start || ''),
      String(period_end || ''),
      Number(approved_run_id),
      String(approved_token || ''),
    ],
  );

  return r.rows.length > 0;
}

async function createApprovalAsanaTask(run) {
  try {
    const vitalsSnapshot = await fetchVitalsSnapshot(run.client_location_id);
    const route = resolveAsanaRoute(run.client_location_id, vitalsSnapshot);

    if (!route || !route.projectGid) {
      appendEvent(run, 'asana_approval_routing_missing', { client_location_id: run.client_location_id });
      notifyFailure({
        step: 'asana_approval_routing',
        error: 'asana_routing_missing',
        runId: run.id,
        clientLocation: run.client_location_id,
        period: `${run.period_start} - ${run.period_end}`,
      });
      return { ok: false, error: 'asana_routing_missing' };
    }

    const period = `${run.period_start} to ${run.period_end}`;
    const taskName = `PAYROLL APPROVED | ${run.client_location_id} | ${period}`;

    const notes = [
      'Payroll has been approved by the client.',
      '',
      `Location: ${run.client_location_id}`,
      `Pay Period: ${period}`,
      `Approved At: ${formatPacific(nowIso())} America/Los_Angeles`,
      `Run ID: ${run.id}`,
      '',
      'Client clicked the APPROVE PAYROLL button in the validation email.',
      'Approval finalizes payroll for this pay period.',
    ].join('\n');

    const externalId = `payroll_approved|${run.client_location_id}|${run.period_start}|${run.period_end}`;

    const task = await createTask({
      projectGid: route.projectGid,
      sectionGid: route.sectionGid,
      name: taskName,
      notes,
      externalId,
    });

    appendEvent(run, 'asana_approval_task_created', { task });
    return { ok: true, task };
  } catch (err) {
    appendEvent(run, 'asana_approval_task_failed', { error: err?.message || String(err || '') });
    notifyFailure({
      step: 'asana_approval_task',
      error: err?.message || 'asana_task_failed',
      runId: run.id,
      clientLocation: run.client_location_id,
      period: `${run.period_start} - ${run.period_end}`,
    });
    return { ok: false, error: 'asana_task_failed' };
  }
}

async function approveAction(token) {
  const v = await validateToken(token, { type: 'approval', allow_used: true });
  if (!v.ok) {
    return {
      ok: false,
      status: 'invalid',
      html: htmlPage('Payroll Approval', 'This approval link is not valid', [
        'This link is missing, expired, already used, or incorrect.',
        `Reason: ${v.reason}`,
      ]),
    };
  }

  const tokenRow = v.token;
  const run = await getRunById(tokenRow.run_id);

  if (!run) {
    return {
      ok: false,
      status: 'missing_run',
      html: htmlPage('Payroll Approval', 'We could not find that payroll run', [
        'Please reply to the email you received and we will help.',
      ]),
    };
  }

  const alreadyApproved = await getPeriodApproval(run.client_location_id, run.period_start, run.period_end);
  if (alreadyApproved) {
    appendEvent(run, 'approve_noop_already_approved', {
      token,
      approved_at: alreadyApproved.approved_at,
      approved_run_id: alreadyApproved.approved_run_id,
    });
    await updateRun(run.id, { events: run.events });

    return {
      ok: true,
      status: 'already_approved',
      html: htmlPage('Payroll Approval', 'Payroll already approved for this pay period', [
        `Location: ${run.client_location_id}`,
        `Period: ${run.period_start} to ${run.period_end}`,
        'No further action is needed.',
      ]),
    };
  }

  // Mark token used (best effort). We allow used tokens to render "already approved" too.
  await markTokenUsed(token);

  const inserted = await insertPeriodApproval(
    run.client_location_id,
    run.period_start,
    run.period_end,
    run.id,
    token,
  );

  if (!inserted) {
    const latest = await getPeriodApproval(run.client_location_id, run.period_start, run.period_end);

    appendEvent(run, 'approve_noop_raced', {
      token,
      approved_at: latest?.approved_at || null,
      approved_run_id: latest?.approved_run_id || null,
    });
    await updateRun(run.id, { events: run.events });

    return {
      ok: true,
      status: 'already_approved',
      html: htmlPage('Payroll Approval', 'Payroll already approved for this pay period', [
        `Location: ${run.client_location_id}`,
        `Period: ${run.period_start} to ${run.period_end}`,
        'No further action is needed.',
      ]),
    };
  }

  appendEvent(run, 'approved', { token });
  await updateRun(run.id, { events: run.events, status: 'approved' });

  const outcome = await getOutcome(run.id);
  if (outcome) {
    await updateOutcome(run.id, {
      status: 'approved',
      approved_at: nowIso(),
      approved_token: token,
    });
  }

  // Create Asana task only on first approval insert.
  await createApprovalAsanaTask(run);
  await updateRun(run.id, { events: run.events });

  return {
    ok: true,
    status: 'approved',
    html: htmlPage('Payroll Approved', 'Payroll approved', [
      `Location: ${run.client_location_id}`,
      `Period: ${run.period_start} to ${run.period_end}`,
      'RDMS has been notified.',
    ]),
  };
}

async function rerunAction(token) {
  const v = await validateToken(token, { type: 'rerun', allow_used: true });
  if (!v.ok) {
    return {
      ok: false,
      status: 'invalid',
      html: htmlPage('Rerun Audit', 'This rerun link is not valid', [
        'This link is missing, expired, already used, or incorrect.',
        `Reason: ${v.reason}`,
      ]),
    };
  }

  const tokenRow = v.token;
  const run = await getRunById(tokenRow.run_id);

  if (!run) {
    return {
      ok: false,
      status: 'missing_run',
      html: htmlPage('Rerun Audit', 'We could not find that payroll run', [
        'Please reply to the email you received and we will help.',
      ]),
    };
  }

  const alreadyApproved = await getPeriodApproval(run.client_location_id, run.period_start, run.period_end);
  if (alreadyApproved) {
    appendEvent(run, 'rerun_blocked_already_approved', {
      token,
      approved_at: alreadyApproved.approved_at,
      approved_run_id: alreadyApproved.approved_run_id,
    });
    await updateRun(run.id, { events: run.events });

    return {
      ok: true,
      status: 'rerun_blocked_already_approved',
      html: htmlPage('Rerun Audit', 'Rerun is disabled because payroll is already approved', [
        `Location: ${run.client_location_id}`,
        `Period: ${run.period_start} to ${run.period_end}`,
        'Payroll has already been approved for this pay period.',
      ]),
    };
  }

  await markTokenUsed(token);

  appendEvent(run, 'rerun_requested', { token });
  await updateRun(run.id, { events: run.events });

  const outcome = await getOutcome(run.id);
  if (outcome) {
    await updateOutcome(run.id, {
      status: 'rerun_requested',
      rerun_requested_at: nowIso(),
      rerun_requested_token: token,
    });
  }

  return {
    ok: true,
    status: 'rerun_requested',
    html: htmlPage('Rerun Requested', 'Rerun requested', [
      `Location: ${run.client_location_id}`,
      `Period: ${run.period_start} to ${run.period_end}`,
      'Please correct your data in your POS system. RDMS will rerun the audit.',
    ]),
  };
}

module.exports = {
  approveAction,
  rerunAction,
};
