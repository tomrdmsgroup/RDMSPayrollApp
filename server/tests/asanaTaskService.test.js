// server/tests/asanaTaskService.test.js

const assert = require('assert');
const {
  resolveAsanaRoute,
  createAsanaTasksForFindings,
  buildIdempotencyKey,
  isFailureFinding,
} = require('../src/domain/asanaTaskService');
const { IdempotencyService } = require('../src/domain/idempotencyService');
const { notifyFailure } = require('../src/domain/failureService');

function testResolveAsanaRouteUsesVitals() {
  const vitals = {
    data: [
      { client_location_id: 'LOC1', asana_project_gid: 'proj1', asana_section_gid: 'sec1' },
      { client_location_id: 'LOC2' },
    ],
  };

  const route = resolveAsanaRoute('LOC1', vitals);
  assert.equal(route.projectGid, 'proj1');
  assert.equal(route.sectionGid, 'sec1');

  const missing = resolveAsanaRoute('LOC3', vitals);
  assert.equal(missing, null);
}

async function testCreateAsanaTasksForFindingsSkipsSuccessesAndUsesIdempotency() {
  const run = {
    id: 5,
    client_location_id: 'LOC1',
    period_start: '2024-01-01',
    period_end: '2024-01-07',
    events: [],
  };

  // MATCH CONTRACT:
  // Asana task creation is controlled by emit_asana_alert (not status).
  const findings = [
    { code: 'F1', status: 'success', emit_asana_alert: true, message: 'Issue one' }, // eligible
    { code: 'NO', status: 'failure', emit_asana_alert: false, message: 'Should not alert' }, // ineligible
    { code: 'F1', status: 'failure', emit_asana_alert: true, message: 'Duplicate' }, // duplicate eligible
  ];

  const vitals = {
    data: [{ client_location_id: 'LOC1', asana_project_gid: 'proj1', asana_section_gid: 'sec1' }],
  };

  const created = [];
  const provider = {
    createTask: async ({ name, notes }) => {
      created.push({ name, notes });
      return { id: `task-${created.length}` };
    },
  };

  const idempotency = new IdempotencyService();

  const tasks = await createAsanaTasksForFindings({
    run,
    findings,
    vitalsSnapshot: vitals,
    asanaProvider: provider,
    idempotencyService: idempotency,
    failureNotifier: notifyFailure,
  });

  assert.equal(tasks.length, 1, 'Should create one task for unique eligible finding');
  assert.equal(created.length, 1, 'Provider should be called once due to idempotency');
  assert.equal(created[0].name.includes('F1'), true);
}

async function testCreateAsanaTasksReportsRoutingFailure() {
  const run = {
    id: 6,
    client_location_id: 'UNKNOWN',
    period_start: '2024-02-01',
    period_end: '2024-02-07',
    events: [],
  };

  // Eligible finding (emit_asana_alert === true) with missing routing should trigger failure.
  const findings = [{ code: 'F2', status: 'success', emit_asana_alert: true, message: 'Needs route' }];

  let failureCalled = false;
  const failureSpy = (payload) => {
    failureCalled = payload?.error === 'asana_routing_missing';
  };

  const result = await createAsanaTasksForFindings({
    run,
    findings,
    vitalsSnapshot: { data: [] },
    asanaProvider: { createTask: async () => ({}) },
    failureNotifier: failureSpy,
  });

  assert.equal(result.length, 0);
  assert.equal(failureCalled, true, 'Should notify failure when routing missing');
}

function testBuildIdempotencyKeyStable() {
  const key = buildIdempotencyKey({
    runId: 1,
    projectGid: 'P1',
    sectionGid: 'S1',
    finding: { code: 'C1', message: 'm' },
  });
  assert.equal(key, '1|P1|S1|C1');
}

function testIsFailureFindingOnlyErrors() {
  assert.equal(isFailureFinding({ status: 'error' }), true);
  assert.equal(isFailureFinding({ status: 'failure' }), true);
  assert.equal(isFailureFinding({ status: 'success' }), false);
}

module.exports = {
  testResolveAsanaRouteUsesVitals,
  testCreateAsanaTasksForFindingsSkipsSuccessesAndUsesIdempotency,
  testCreateAsanaTasksReportsRoutingFailure,
  testBuildIdempotencyKeyStable,
  testIsFailureFindingOnlyErrors,
};
