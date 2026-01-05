// server/src/domain/approvalService.js
//
// Step 2 plus rerun automation and copy updates.
//
// Rules
// - Approval is final for a location + pay period.
// - Once any approval exists for that location + pay period, reruns are blocked.
// - Approve always succeeds (or no-ops as "already approved") even if rerun was clicked earlier.
// - On first approval for the pay period, create ONE Asana task using Airtable Vitals routing.
// - Rerun triggers a fresh audit run immediately and sends a new email.
// - Confirmation pages show a contact line using the Airtable payroll project email address.

const { query } = require('./db');
const { validateToken, markTokenUsed } = require('./tokenService');
const { createRun, getRunById, updateRun, appendEvent, nowIso } = require('./runManager');
const { buildOutcome, saveOutcome, getOutcome, updateOutcome } = require('./outcomeService');
const { buildArtifacts } = require('./artifactService');
const { composeEmail } = require('./emailComposer');
const { sendOutcomeEmail } = require('./emailService');

const { fetchVitalsSnapshot } = require('../providers/vitalsProvider');
const { resolveAsanaRoute } = require('./asanaTaskService');
const { createTask } = require('../providers/asanaProvider');
const { notifyFailure } = require('./failureService');

const AIRTABLE_PAYROLL_EMAIL_FIELD = 'PR RDMS Payroll Project Email Address';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

function htmlPage({ title, heading, lines, contactEmail }) {
  const safeTitle = escapeHtml(title);
  const safeHeading = escapeHtml(heading);
  const body = (Array.isArray(lines) ? lines : [])
    .map((t) => `<p style="margin:0 0 12px 0;">${escapeHtml(t)}</p>`)
    .join('');

  const footerLine = contactEmail
    ? `If you reached this page by mistake, please email ${contactEmail}.`
    : 'If you reached this page by mistake, please reply to the email you received.';

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
        ${escapeHtml(footerLine)}
      </div>
    </div>
  </body>
</html>`;
}

async function getPayrollContactEmail(client_location_id) {
  try {
    const snapshot = await fetchVitalsSnapshot(client_location_id);
    const record = (snapshot && snapshot.data && snapshot.data[0]) || null;
    const email = record && record[AIRTABLE_PAYROLL_EMAIL_FIELD] ? String(record[AIRTABLE_PAYROLL_EMAIL_FIELD]).trim() : '';
    return email || '';
  } catch (_) {
    return '';
  }
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

async function triggerRerunAndEmail({ sourceRun, sourceOutcome }) {
  const policySnapshot = sourceOutcome?.policy_snapshot || sourceRun?.payload?.policy_snapshot || null;

  const newRun = await createRun({
    client_location_id: sourceRun.client_location_id,
    period_start: sourceRun.period_start,
    period_end: sourceRun.period_end,
    payload: { policy_snapshot: policySnapshot },
    status: 'running',
  });

  appendEvent(newRun, 'rerun_created', { from_run_id: sourceRun.id });
  await updateRun(newRun.id, { events: newRun.events });

  const artifacts = buildArtifacts({ run: newRun, policySnapshot: policySnapshot || {} });
  const outcome = await buildOutcome(newRun, [], artifacts, policySnapshot);
  const savedOutcome = await saveOutcome(newRun.id, outcome);

  appendEvent(newRun, 'ops_outcome_saved', { outcome_status: savedOutcome.status });
  await updateRun(newRun.id, { events: newRun.events });

  // Ensure recipients carry forward if policy snapshot did not include them.
  const recipients = Array.isArray(sourceOutcome?.delivery?.recipients) ? sourceOutcome.delivery.recipients : [];
  if (recipients.length && (!savedOutcome.delivery.recipients || savedOutcome.delivery.recipients.length === 0)) {
    await updateOutcome(newRun.id, { delivery: { recipients } });
  }

  const latestOutcome = await getOutcome(newRun.id);
  const rendered = composeEmail(latestOutcome, newRun);
  if (!rendered.ok) {
    appendEvent(newRun, 'ops_email_render_failed', { error: rendered.error });
    await updateRun(newRun.id, { events: newRun.events, status: 'completed' });
    return { ok: false, error: rendered.error, newRunId: newRun.id };
  }

  const readyOutcome = await updateOutcome(newRun.id, {
    delivery: {
      subject: rendered.subject,
      rendered_text: rendered.text,
      rendered_html: rendered.html,
    },
  });

  const sendResult = await sendOutcomeEmail(readyOutcome);

  if (sendResult?.ok) {
    await updateOutcome(newRun.id, {
      status: 'delivered',
      delivery: {
        sent_at: nowIso(),
        provider_message_id: sendResult.providerMessageId || null,
      },
    });

    appendEvent(newRun, 'ops_email_sent', { provider_message_id: sendResult.providerMessageId });
    await updateRun(newRun.id, { status: 'completed', events: newRun.events });

    return { ok: true, newRunId: newRun.id, messageId: sendResult.providerMessageId || null };
  }

  appendEvent(newRun, 'ops_email_send_failed', { error: sendResult?.error || 'email_send_failed' });
  await updateRun(newRun.id, { status: 'completed', events: newRun.events });
  return { ok: false, error: sendResult?.error || 'email_send_failed', newRunId: newRun.id };
}

async function approveAction(token) {
  const v = await validateToken(token, { type: 'approval', allow_used: true });
  const contactEmail = v?.token?.client_location_id ? await getPayrollContactEmail(v.token.client_location_id) : '';

  if (!v.ok) {
    return {
      ok: false,
      status: 'invalid',
      html: htmlPage({
        title: 'Payroll Approval',
        heading: 'This approval link is not valid',
        lines: ['This link is missing, expired, already used, or incorrect.', `Reason: ${v.reason}`],
        contactEmail,
      }),
    };
  }

  const tokenRow = v.token;
  const run = await getRunById(tokenRow.run_id);

  const runContactEmail = run ? await getPayrollContactEmail(run.client_location_id) : contactEmail;

  if (!run) {
    return {
      ok: false,
      status: 'missing_run',
      html: htmlPage({
        title: 'Payroll Approval',
        heading: 'We could not find that payroll run',
        lines: ['Please reply to the email you received and we will help.'],
        contactEmail: runContactEmail,
      }),
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
      html: htmlPage({
        title: 'Payroll Approval',
        heading: 'Payroll already approved for this pay period',
        lines: [`Location: ${run.client_location_id}`, `Period: ${run.period_start} to ${run.period_end}`, 'No further action is needed.'],
        contactEmail: runContactEmail,
      }),
    };
  }

  await markTokenUsed(token);

  const inserted = await insertPeriodApproval(run.client_location_id, run.period_start, run.period_end, run.id, token);

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
      html: htmlPage({
        title: 'Payroll Approval',
        heading: 'Payroll already approved for this pay period',
        lines: [`Location: ${run.client_location_id}`, `Period: ${run.period_start} to ${run.period_end}`, 'No further action is needed.'],
        contactEmail: runContactEmail,
      }),
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

  await createApprovalAsanaTask(run);
  await updateRun(run.id, { events: run.events });

  return {
    ok: true,
    status: 'approved',
    html: htmlPage({
      title: 'Payroll Approved',
      heading: 'Payroll approved',
      lines: [`Location: ${run.client_location_id}`, `Period: ${run.period_start} to ${run.period_end}`, 'RDMS has been notified.'],
      contactEmail: runContactEmail,
    }),
  };
}

async function rerunAction(token) {
  const v = await validateToken(token, { type: 'rerun', allow_used: true });
  const contactEmail = v?.token?.client_location_id ? await getPayrollContactEmail(v.token.client_location_id) : '';

  if (!v.ok) {
    return {
      ok: false,
      status: 'invalid',
      html: htmlPage({
        title: 'Rerun Audit',
        heading: 'This rerun link is not valid',
        lines: ['This link is missing, expired, already used, or incorrect.', `Reason: ${v.reason}`],
        contactEmail,
      }),
    };
  }

  const tokenRow = v.token;
  const run = await getRunById(tokenRow.run_id);
  const runContactEmail = run ? await getPayrollContactEmail(run.client_location_id) : contactEmail;

  if (!run) {
    return {
      ok: false,
      status: 'missing_run',
      html: htmlPage({
        title: 'Rerun Audit',
        heading: 'We could not find that payroll run',
        lines: ['Please reply to the email you received and we will help.'],
        contactEmail: runContactEmail,
      }),
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
      html: htmlPage({
        title: 'Rerun Audit',
        heading: 'Rerun is disabled because payroll is already approved',
        lines: [
          `Location: ${run.client_location_id}`,
          `Period: ${run.period_start} to ${run.period_end}`,
          'Payroll has already been approved for this pay period.',
        ],
        contactEmail: runContactEmail,
      }),
    };
  }

  await markTokenUsed(token);

  appendEvent(run, 'rerun_clicked', { token });
  await updateRun(run.id, { events: run.events });

  const sourceOutcome = await getOutcome(run.id);
  if (sourceOutcome) {
    await updateOutcome(run.id, {
      status: 'rerun_requested',
      rerun_requested_at: nowIso(),
      rerun_requested_token: token,
    });
  }

  // Auto-trigger the rerun immediately and send the new email.
  const trigger = await triggerRerunAndEmail({ sourceRun: run, sourceOutcome });

  appendEvent(run, 'rerun_trigger_result', {
    ok: trigger.ok,
    new_run_id: trigger.newRunId || null,
    provider_message_id: trigger.messageId || null,
    error: trigger.ok ? null : trigger.error,
  });
  await updateRun(run.id, { events: run.events });

  return {
    ok: true,
    status: 'rerun_started',
    html: htmlPage({
      title: 'Rerun Started',
      heading: 'Payroll Validation Audit will be delivered shortly',
      lines: [
        `Location: ${run.client_location_id}`,
        `Period: ${run.period_start} to ${run.period_end}`,
        'RDMS is rerunning the audit to capture your corrected POS data.',
      ],
      contactEmail: runContactEmail,
    }),
  };
}

module.exports = {
  approveAction,
  rerunAction,
};
