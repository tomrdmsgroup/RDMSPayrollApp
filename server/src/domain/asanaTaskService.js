// server/src/domain/asanaTaskService.js

const { createTask } = require('../providers/asanaProvider');
const { notifyFailure } = require('./failureService');
const { IdempotencyService } = require('./idempotencyService');
const { appendEvent } = require('./runManager');

/**
 * Resolve Asana routing from vitals snapshot.
 * Routing is required ONLY if we have findings that require Asana tasks.
 */
function resolveAsanaRoute(clientLocationId, vitalsSnapshot) {
  if (!vitalsSnapshot?.data || !clientLocationId) return null;

  const match = vitalsSnapshot.data.find(
    (record) =>
      `${record.client_location_id}` === `${clientLocationId}` ||
      `${record.id}` === `${clientLocationId}`,
  );

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
 * Idempotency key is stable per:
 * run + project + section + finding identity
 */
function buildIdempotencyKey({ runId, projectGid, sectionGid, finding }) {
  const code = finding?.code || finding?.id || finding?.message || 'unknown';
  return [runId || 'unknown', projectGid, sectionGid || '', code].join('|');
}

/**
 * Binder-correct gating:
 * Only create Asana tasks when explicitly requested by the finding.
 */
function shouldCreateClientAsanaTask(finding) {
  return finding?.emit_asana_alert === true;
}

function buildTaskPayload({ finding, run, route }) {
  const period = run ? `${run.period_start} - ${run.period_end}` : '';
  const name = `${finding.code || 'Validation Finding'} (${period.trim()})`;

  const notes = [
    finding.message || 'Validation issue detected.',
    finding.details ? `Details: ${finding.details}` : null,
    run ? `Client/Location: ${run.client_location_id}` : null,
    route.sectionGid ? `Section: ${route.sectionGid}` : null,
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
 * - If ANY eligible finding exists and routing is missing -> this is a system failure (failureService).
 * - If NO eligible findings exist -> routing may be missing with no failure.
 * - Idempotency prevents duplicate task creation.
 */
async function createAsanaTasksForFindings({
  run,
  findings = [],
  vitalsSnapshot,
  idempotencyService = new IdempotencyService(),
  asanaProvider = { createTask },
}) {
  if (!run || !findings.length) return [];

  const eligibleFindings = findings.filter(shouldCreateClientAsanaTask);
  if (!eligibleFindings.length) return [];

  const route = resolveAsanaRoute(run.client_location_id, vitalsSnapshot);

  // Routing missing is a failure ONLY because we have eligible findings that require Asana tasks.
  if (!route) {
    appendEvent(run, 'asana_routing_missing', {
      client_location_id: run.client_location_id,
    });

    notifyFailure({
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
      // Task creation failure IS a system failure
      notifyFailure({
        step: 'asana_task',
        error: err.message || 'asana_task_failed',
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
  shouldCreateClientAsanaTask,
  buildIdempotencyKey,
  buildTaskPayload,
};
