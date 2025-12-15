const assert = require('assert');
const { createTask, buildTasksUrl, getAccessToken } = require('../../src/providers/asanaProvider');

async function testCreateTaskSendsRequest() {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = (url, options) => {
    captured = { url: url.toString(), options };
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            gid: '123',
            name: 'Test Task',
            permalink_url: 'https://app.asana.com/0/123/456',
          },
        }),
    });
  };

  process.env.ASANA_ACCESS_TOKEN = 'token123';
  const task = await createTask({ projectGid: 'proj1', sectionGid: 'sec1', name: 'Test Task', notes: 'Body', externalId: 'ext-1' });

  assert.ok(captured.url.endsWith('/tasks'), 'Should post to tasks endpoint');
  const body = JSON.parse(captured.options.body);
  assert.equal(body.data.projects[0], 'proj1');
  assert.equal(body.data.memberships[0].section, 'sec1');
  assert.equal(body.data.external.gid, 'ext-1');
  assert.equal(task.id, '123');

  global.fetch = originalFetch;
}

async function testCreateTaskHandlesErrors() {
  const originalFetch = global.fetch;
  global.fetch = () =>
    Promise.resolve({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ errors: [{ message: 'Bad Request' }] }),
    });
  process.env.ASANA_ACCESS_TOKEN = 'token123';

  let threw = false;
  try {
    await createTask({ projectGid: 'proj1', name: 'Broken' });
  } catch (err) {
    threw = true;
    assert.equal(err.message, 'Bad Request');
  }
  assert.equal(threw, true, 'Should throw on non-ok response');
  global.fetch = originalFetch;
}

function testBuildTasksUrlUsesEnv() {
  process.env.ASANA_BASE_URL = 'https://example.asana.test/api';
  const url = buildTasksUrl();
  assert.ok(url.toString().startsWith('https://example.asana.test/api'));
}

function testGetAccessTokenRequiresEnv() {
  delete process.env.ASANA_ACCESS_TOKEN;
  let threw = false;
  try {
    getAccessToken();
  } catch (err) {
    threw = true;
    assert.equal(err.message, 'asana_access_token_required');
  }
  assert.equal(threw, true, 'Should require token');
}

module.exports = { testCreateTaskSendsRequest, testCreateTaskHandlesErrors, testBuildTasksUrlUsesEnv, testGetAccessTokenRequiresEnv };
