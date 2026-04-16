const fetch = require('node-fetch');

const { fetchAirtableRecords } = require('../providers/airtableClient');

const TOAST_AIRTABLE_FIELDS = {
  hostname: 'Toast API Hostname',
  oauthUrl: 'Toast API OAuth URL',
  userAccessType: 'Toast API User Access Type',
  restaurantGuid: 'Toast API Restaurant GUID',
  restaurantExternalId: 'Toast API Restaurant External ID',
  locationId: 'Toast Location ID',
};

function safeStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function normalizeHostname(raw) {
  const value = safeStr(raw);
  if (!value) return null;

  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      return new URL(value).host || null;
    } catch (_) {
      return null;
    }
  }

  if (value.includes('/') && !value.includes('://')) {
    try {
      return new URL(`https://${value}`).host || null;
    } catch (_) {
      return null;
    }
  }

  return value;
}

function escapeAirtableString(v) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function getRequiredEnv(key) {
  const value = safeStr(process.env[key]);
  if (!value) throw new Error(`missing_${key}`);
  return value;
}

function getAirtableVitalsConfig() {
  return {
    baseId: getRequiredEnv('AIRTABLE_VITALS_BASE'),
    apiKey: safeStr(process.env.AIRTABLE_VITALS_API_KEY || process.env.AIRTABLE_API_KEY),
    tableName: safeStr(process.env.AIRTABLE_VITALS_TABLE || 'Vitals'),
    locationField: safeStr(process.env.AIRTABLE_VITALS_LOCATION_FIELD || 'Name'),
  };
}

function getBarrioToastSecrets() {
  const standardClientId = safeStr(process.env.TOAST_STD_CLIENT_ID_BARRIO);
  const standardClientSecret = safeStr(process.env.TOAST_STD_CLIENT_SECRET_BARRIO);
  const analyticsClientId = safeStr(process.env.TOAST_AN_CLIENT_ID_BARRIO);
  const analyticsClientSecret = safeStr(process.env.TOAST_AN_CLIENT_SECRET_BARRIO);

  return {
    standardClientId,
    standardClientSecret,
    analyticsClientId,
    analyticsClientSecret,
    summary: {
      hasToastStdClientIdBarrio: !!standardClientId,
      hasToastStdClientSecretBarrio: !!standardClientSecret,
      hasToastAnClientIdBarrio: !!analyticsClientId,
      hasToastAnClientSecretBarrio: !!analyticsClientSecret,
    },
  };
}

function buildNonSecretToastConfig(fields) {
  const hostname = normalizeHostname(fields[TOAST_AIRTABLE_FIELDS.hostname]);
  const oauthUrl = safeStr(fields[TOAST_AIRTABLE_FIELDS.oauthUrl]) || null;
  const userAccessType = safeStr(fields[TOAST_AIRTABLE_FIELDS.userAccessType]) || null;
  const restaurantGuid =
    safeStr(fields[TOAST_AIRTABLE_FIELDS.restaurantGuid]) ||
    safeStr(fields[TOAST_AIRTABLE_FIELDS.restaurantExternalId]) ||
    null;
  const locationId = safeStr(fields[TOAST_AIRTABLE_FIELDS.locationId]) || null;

  return {
    hostname,
    oauthUrl,
    userAccessType,
    restaurantGuid,
    locationId,
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function fetchVitalsForLocation(locationName) {
  const cfg = getAirtableVitalsConfig();
  if (!cfg.apiKey) throw new Error('missing_AIRTABLE_VITALS_API_KEY');

  const filterByFormula = `{${cfg.locationField}}='${escapeAirtableString(locationName)}'`;

  const { records } = await fetchAirtableRecords({
    baseId: cfg.baseId,
    tableName: cfg.tableName,
    apiKey: cfg.apiKey,
    filterByFormula,
  });

  if (!records.length) return { found: false, recordId: null, fields: null };

  const record = records[0];
  return {
    found: true,
    recordId: record.id,
    fields: record.fields || {},
  };
}

function buildStandardHeaders({ token, restaurantGuid }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Toast-Access-Type': 'TOAST_MACHINE_CLIENT',
    'X-Toast-Access-Type': 'TOAST_MACHINE_CLIENT',
  };

  if (restaurantGuid) {
    headers['Toast-Restaurant-External-Id'] = restaurantGuid;
    headers['restaurant-external-id'] = restaurantGuid;
    headers['Toast-Restaurant-Id'] = restaurantGuid;
  }

  return headers;
}

async function toastStandardLogin({ oauthUrl, userAccessType, clientId, clientSecret }) {
  const response = await fetch(oauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      clientId,
      clientSecret,
      userAccessType,
    }),
  });

  const body = await safeJson(response);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: 'toast_auth_failed',
      details: body && typeof body === 'object' ? Object.keys(body) : null,
    };
  }

  const token = body?.token?.accessToken || body?.accessToken || body?.access_token || null;
  if (!token) return { ok: false, status: response.status, error: 'toast_auth_missing_token' };

  return { ok: true, status: response.status, token };
}

async function fetchToastEmployees({ hostname, token, restaurantGuid }) {
  const baseUrl = `https://${hostname}`;
  const headers = buildStandardHeaders({ token, restaurantGuid });

  const urls = [new URL('/labor/v1/employees', baseUrl), new URL('/hr/v1/employees', baseUrl)];

  for (const url of urls) {
    const response = await fetch(url.toString(), { method: 'GET', headers });
    const body = await safeJson(response);
    if (!response.ok) continue;

    const rows = Array.isArray(body)
      ? body
      : Array.isArray(body?.employees)
      ? body.employees
      : Array.isArray(body?.data)
      ? body.data
      : [];

    return {
      ok: true,
      endpointUsed: url.pathname,
      count: rows.length,
      rows,
    };
  }

  return {
    ok: false,
    error: 'toast_employees_failed',
  };
}

function toEmployeeSample(rows) {
  return rows.slice(0, 5).map((row) => ({
    employeeId: row?.id || row?.employeeId || row?.guid || null,
    employeeName:
      row?.fullName ||
      row?.name ||
      [safeStr(row?.firstName), safeStr(row?.lastName)].filter(Boolean).join(' ') ||
      null,
  }));
}

async function runBarrioToastProof(locationName) {
  const cleanedLocationName = safeStr(locationName);
  if (!cleanedLocationName) {
    return { ok: false, locationName: null, failureReason: 'locationName_required' };
  }

  const result = {
    ok: false,
    locationName: cleanedLocationName,
    airtableConfigFound: false,
    authSucceeded: false,
    employeeCount: 0,
    employeeSample: [],
    failureReason: null,
    airtableFieldsUsed: {
      locationFieldFromEnv: safeStr(process.env.AIRTABLE_VITALS_LOCATION_FIELD || 'Name'),
      toastFields: Object.values(TOAST_AIRTABLE_FIELDS),
    },
    envVarsRead: [
      'AIRTABLE_VITALS_BASE',
      'AIRTABLE_VITALS_API_KEY (fallback AIRTABLE_API_KEY)',
      'AIRTABLE_VITALS_TABLE',
      'AIRTABLE_VITALS_LOCATION_FIELD',
      'TOAST_STD_CLIENT_ID_BARRIO',
      'TOAST_STD_CLIENT_SECRET_BARRIO',
      'TOAST_AN_CLIENT_ID_BARRIO',
      'TOAST_AN_CLIENT_SECRET_BARRIO',
    ],
  };

  try {
    const vitals = await fetchVitalsForLocation(cleanedLocationName);
    result.airtableConfigFound = vitals.found;

    if (!vitals.found) {
      result.failureReason = 'location_not_found_in_airtable_vitals';
      return result;
    }

    const nonSecretConfig = buildNonSecretToastConfig(vitals.fields);
    result.nonSecretConfig = {
      hasHostname: !!nonSecretConfig.hostname,
      hasOauthUrl: !!nonSecretConfig.oauthUrl,
      hasUserAccessType: !!nonSecretConfig.userAccessType,
      hasRestaurantGuid: !!nonSecretConfig.restaurantGuid,
      hasLocationId: !!nonSecretConfig.locationId,
    };

    const secrets = getBarrioToastSecrets();
    result.secretConfig = secrets.summary;

    if (!nonSecretConfig.hostname || !nonSecretConfig.oauthUrl || !nonSecretConfig.userAccessType || !nonSecretConfig.restaurantGuid) {
      result.failureReason = 'toast_non_secret_config_incomplete';
      return result;
    }

    if (!secrets.standardClientId || !secrets.standardClientSecret) {
      result.failureReason = 'toast_standard_secret_config_incomplete';
      return result;
    }

    const auth = await toastStandardLogin({
      oauthUrl: nonSecretConfig.oauthUrl,
      userAccessType: nonSecretConfig.userAccessType,
      clientId: secrets.standardClientId,
      clientSecret: secrets.standardClientSecret,
    });

    result.authSucceeded = !!auth.ok;
    if (!auth.ok) {
      result.failureReason = auth.error || 'toast_auth_failed';
      result.authStatus = auth.status || null;
      return result;
    }

    const employees = await fetchToastEmployees({
      hostname: nonSecretConfig.hostname,
      token: auth.token,
      restaurantGuid: nonSecretConfig.restaurantGuid,
    });

    if (!employees.ok) {
      result.failureReason = employees.error || 'toast_employees_failed';
      return result;
    }

    result.ok = true;
    result.employeeCount = employees.count;
    result.employeeSample = toEmployeeSample(employees.rows);
    result.endpointUsed = employees.endpointUsed;

    return result;
  } catch (error) {
    result.failureReason = error?.message || 'toast_barrio_proof_failed';
    return result;
  }
}

module.exports = {
  TOAST_AIRTABLE_FIELDS,
  runBarrioToastProof,
};
