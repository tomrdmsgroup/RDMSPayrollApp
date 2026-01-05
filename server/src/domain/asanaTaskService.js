// server/src/domain/asanaTaskService.js

const { createTask } = require('../providers/asanaProvider');
const { notifyFailure } = require('./failureService');
const { IdempotencyService } = require('./idempotencyService');
const { appendEvent } = require('./runManager');

/**
 * Resolve Asana routing from vitals snapshot.
 *
 * IMPORTANT:
 * vitalsProvider returns records that always include:
 * - record.id (Airtable record id)
 * - record[locationField] (usually "Name") containing the location name text
 *
 * It does NOT guarantee record.client_location_id exists on each record.
 * So routing must match using:
 * - clientLocationId equals Airtable record id, OR
 * - clientLocationId equals record[locationField], OR
 * - clientLocationId equals record.Name (fallback)
 */
function resolveAsanaRoute(clientLocationId, vitalsSnapshot) {
  if (!clientLocationId || !vitalsSnapshot?.data || !Array.isArray(vitalsSnapshot.data)) return null;

  const locationField = vitalsSnapshot.location_field || 'Name';

  const wanted = `${clientLocationId}`.trim();

  const match = vitalsSnapshot.data.find((record) => {
    const recordId = record?.id != null ? `${record.id}`.trim() : '';
    const fieldValue =
      record && record[locationField] != null ? `${record[locationField]}`.trim() : '';
    const nameFallback = record && record.Name != null ? `${record.Name}`.trim() : '';

    return wanted === recordId || wanted === fieldValue || wanted === nameFallback;
  });

  if (!match) return null;

  const projectGid =
    match['PR Asana Project GUID'] ||
    match.asana_project_gid ||
    match.asana_project_id ||
    match.asana_project ||
    match.asana_projectid;

  const sectionGid =
    match['PR Asana Inbox Section GUID'] ||
    match.asana_section_gid ||
    match.asana_section_id ||
    match.asana_section ||
    match.asana_sectionid;

  if (!projectGid) return null;

  return {
    projectGid: `${projectGid}`.trim(),
    sectionGid: sectionGid ? `${sectionGid}`.trim() : null,
  };
}

/**
 * Treat only failures/errors as actionable findings.
 * (Kept for compatibility; Asana task gating is controlled by emit_asana_alert.)
 */
function isFailureFinding(finding) {
  const status = (finding?.status || '').toString().toLowerCase().trim();
  return status === 'failure' || status === 'error';
}

function normalizeBoolean(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;

  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'y';
  }

  return false;
}

/**
 * Idempotency key is stable per:
 * run + project + section + finding identity
 */
function buildIdempotencyKey({ runId, projectGid, sectionGid, finding }) {
  const code = finding?.code || finding?.id || finding?.message || 'unknown';
  return [runId || 'unknown', projectGid, sectionGid || '', code].join('|');
}

/**
 * CODEX contract:
 * Whether a finding should create an Asana task is controlled by emit_asana_alert.
 */
function shouldCreateClientAsanaTask(finding) {
  return normalizeBoolean(finding?.emit_asana_alert);
}

function buildTaskPayload({ finding, run, route }) {
  const period = run ? `${run.period_start} - ${run.period_end}` : '';
  const name = `${finding.code || 'Validation Finding'} (${period.trim()})`;

  const notes = [
    finding.message || 'Validation issue detected.',
    finding.details ? `Details: ${finding.details}` : null,
    run ? `Client/Location: ${run.client_location_id}` : null,
    route?.sectionGid ? `Section: ${route.sectionGid}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return { name, notes };
}

/**
 * Create Asana tasks for findings.
 *
 * Rules:
 * - Only findings with emit_asana_alert === true are eligible.
 * - If ANY eligible finding exists and routing is missing -> notify failure.
 * - Idempotency prevents duplicate task creation.
 */
async function createAsanaTasksForFindings({
  run,
  findings = [],
  vitalsSnapshot,
  idempotencyService = new IdempotencyService(),
  asanaProvider = { createTask },
  failureNotifier = notifyFailure,
}) {
  if (!run || !Array.isArray(findings) || findings.length === 0) return [];

  const eligibleFindings = findings.filter(shouldCreateClientAsanaTask);
  if (eligibleFindings.length === 0) return [];

  const route = resolveAsanaRoute(run.client_location_id, vitalsSnapshot);

  if (!route) {
    appendEvent(run, 'asana_routing_missing', {
      client_location_id: run.client_location_id,
      location_field: vitalsSnapshot?.location_field || 'Name',
    });

    failureNotifier({
      step: 'asana_routing',
      error: 'asana_routing_missing',
      runId: run.id,
      clientLocation: run.client_location_id,
      period: `${run.period_start} - ${run.period_end}`,
    });

    return [];
  }

  const results = [];

  for (const finding of eligibleFindings) {
    const key = buildIdempotencyKey({
      runId: run.id,
      projectGid: route.projectGid,
      sectionGid: route.sectionGid,
      finding,
    });

    const recorded = idempotencyService.record('asana_task', key);
    if (!recorded) continue;

    const payload = buildTaskPayload({ finding, run, route });

    try {
      const task = await asanaProvider.createTask({
        projectGid: route.projectGid,
        sectionGid: route.sectionGid,
        name: payload.name,
        notes: payload.notes,
        externalId: key,
      });

      appendEvent(run, 'asana_task_created', { key, task });
      results.push(task);
    } catch (err) {
      failureNotifier({
        step: 'asana_task',
        error: err?.message || 'asana_task_failed',
        runId: run.id,
        clientLocation: run.client_location_id,
        period: `${run.period_start} - ${run.period_end}`,
      });
    }
  }

  return results;
}

module.exports = {
  resolveAsanaRoute,
  createAsanaTasksForFindings,
  buildIdempotencyKey,
  buildTaskPayload,
  shouldCreateClientAsanaTask,
  isFailureFinding,
};
