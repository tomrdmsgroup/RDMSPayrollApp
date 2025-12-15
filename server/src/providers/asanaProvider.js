const DEFAULT_ASANA_URL = 'https://app.asana.com/api/1.0';

function getAccessToken() {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) throw new Error('asana_access_token_required');
  return token;
}

function buildTasksUrl() {
  const baseUrl = process.env.ASANA_BASE_URL || DEFAULT_ASANA_URL;
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('tasks', normalized);
}

async function createTask({ projectGid, sectionGid, name, notes, externalId, customFields = {} }) {
  if (!projectGid) throw new Error('asana_project_required');
  if (!name) throw new Error('asana_name_required');

  const token = getAccessToken();
  const url = buildTasksUrl();

  const body = {
    data: {
      name,
      notes,
      projects: [projectGid],
      custom_fields: Object.keys(customFields).length ? customFields : undefined,
    },
  };

  if (sectionGid) {
    body.data.memberships = [{ project: projectGid, section: sectionGid }];
  }

  if (externalId) {
    body.data.external = { gid: externalId };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await safeParseJson(response);
    const message = err?.errors?.[0]?.message || err?.message || `asana_error_${response.status}`;
    throw new Error(message);
  }

  const json = await response.json();
  const task = json?.data || {};
  return {
    id: task.gid || task.id,
    name: task.name,
    url: task.permalink_url || task.url,
    raw: task,
  };
}

async function safeParseJson(response) {
  try {
    return await response.json();
  } catch (e) {
    return null;
  }
}

module.exports = { createTask, buildTasksUrl, getAccessToken };
