// server/src/api/routes.js
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
