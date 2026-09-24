import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZohoClient } from './zoho.ts';

const ENV = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt', accountsUrl: 'https://acc.test', apiUrl: 'https://api.test', ownerId: 'o1' };

function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = script.shift();
    if (!step) throw new Error('unexpected fetch ' + url);
    if (step.throw) throw step.throw;
    return new Response(JSON.stringify(step.body), { status: step.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

test('disabled when credentials are missing: skipped, no fetch', async () => {
  const f = fakeFetch([]);
  const z = createZohoClient({ env: {}, fetch: f });
  assert.equal(z.enabled, false);
  const r = await z.upsertLead({ Email: 'a@b.c' });
  assert.deepEqual(r, { ok: false, skipped: true, error: 'zoho not configured' });
  assert.equal(f.calls.length, 0);
});

test('refreshes token once, caches it, upserts with duplicate check on Email', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT1', expires_in: 3600 } },
    { body: { data: [{ code: 'SUCCESS', action: 'insert', details: { id: '111' }, status: 'success' }] } },
    { body: { data: [{ code: 'SUCCESS', action: 'update', details: { id: '111' }, status: 'success' }] } },
  ]);
  let t = 1_000_000;
  const z = createZohoClient({ env: ENV, fetch: f, now: () => t });
  const r1 = await z.upsertLead({ Email: 'a@b.c', Last_Name: 'X' });
  assert.deepEqual(r1, { ok: true, id: '111', action: 'insert' });
  const r2 = await z.upsertLead({ Email: 'a@b.c', Last_Name: 'X' });
  assert.deepEqual(r2, { ok: true, id: '111', action: 'update' });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].url, 'https://acc.test/oauth/v2/token');
  assert.match(f.calls[0].init.body, /grant_type=refresh_token/);
  assert.equal(f.calls[1].url, 'https://api.test/crm/v7/Leads/upsert');
  assert.equal(f.calls[1].init.headers.Authorization, 'Zoho-oauthtoken AT1');
  const sent = JSON.parse(f.calls[1].init.body);
  assert.deepEqual(sent.duplicate_check_fields, ['Email']);
  assert.equal(sent.data[0].Email, 'a@b.c');
});

test('re-refreshes after expiry (60 s safety margin)', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT1', expires_in: 3600 } },
    { body: { data: [{ code: 'SUCCESS', action: 'insert', details: { id: '1' } }] } },
    { body: { access_token: 'AT2', expires_in: 3600 } },
    { body: { data: [{ code: 'SUCCESS', action: 'insert', details: { id: '2' } }] } },
  ]);
  let t = 0;
  const z = createZohoClient({ env: ENV, fetch: f, now: () => t });
  await z.upsertLead({ Email: 'a@b.c' });
  t = 3600_000 - 30_000; // inside the margin → must refresh
  await z.upsertLead({ Email: 'a@b.c' });
  assert.equal(f.calls[3].init.headers.Authorization, 'Zoho-oauthtoken AT2');
});

test('HTTP 200 with per-record error is a failure with details', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT1', expires_in: 3600 } },
    { body: { data: [{ code: 'INVALID_DATA', status: 'error', message: 'invalid data', details: { api_name: 'Lead_Source', expected_data_type: 'picklist' } }] } },
  ]);
  const z = createZohoClient({ env: ENV, fetch: f });
  const r = await z.upsertLead({ Email: 'a@b.c' });
  assert.equal(r.ok, false);
  assert.match(r.error, /INVALID_DATA/);
  assert.match(r.error, /Lead_Source/);
});

test('token endpoint error and network error both return ok:false, never throw', async () => {
  const z1 = createZohoClient({ env: ENV, fetch: fakeFetch([{ status: 400, body: { error: 'invalid_code' } }]) });
  const r1 = await z1.upsertLead({ Email: 'a@b.c' });
  assert.equal(r1.ok, false); assert.match(r1.error, /token/);
  const z2 = createZohoClient({ env: ENV, fetch: fakeFetch([{ throw: new Error('ECONNREFUSED') }]) });
  const r2 = await z2.upsertLead({ Email: 'a@b.c' });
  assert.equal(r2.ok, false); assert.match(r2.error, /ECONNREFUSED/);
});

test('failed token fetch is not cached: next call retries the refresh', async () => {
  const f = fakeFetch([
    { status: 500, body: {} },
    { body: { access_token: 'AT1', expires_in: 3600 } },
    { body: { data: [{ code: 'SUCCESS', action: 'insert', details: { id: '9' } }] } },
  ]);
  const z = createZohoClient({ env: ENV, fetch: f });
  assert.equal((await z.upsertLead({ Email: 'a@b.c' })).ok, false);
  assert.equal((await z.upsertLead({ Email: 'a@b.c' })).ok, true);
});

test('addNote posts to Notes with the parent lead', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT1', expires_in: 3600 } },
    { body: { data: [{ code: 'SUCCESS', details: { id: 'n1' } }] } },
  ]);
  const z = createZohoClient({ env: ENV, fetch: f });
  assert.equal(await z.addNote('111', 'Repeat', 'body'), true);
  assert.equal(f.calls[1].url, 'https://api.test/crm/v7/Notes');
  const sent = JSON.parse(f.calls[1].init.body);
  assert.deepEqual(sent.data[0].Parent_Id, { module: { api_name: 'Leads' }, id: '111' });
  assert.equal(sent.data[0].Note_Title, 'Repeat');
});
