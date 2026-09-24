import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZohoClient } from './zoho.ts';

const ENV = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt', accountsUrl: 'https://acc.test', apiUrl: 'https://api.test', ownerId: 'o1' };
const TOKEN = { body: { access_token: 'AT1', expires_in: 3600 } };

function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = script.shift();
    if (!step) throw new Error('unexpected fetch ' + url);
    if (step.throw) throw step.throw;
    if (step.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(step.body), { status: step.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

test('disabled when credentials are missing: no fetch, every call reports skipped', async () => {
  const f = fakeFetch([]);
  const z = createZohoClient({ env: {}, fetch: f });
  assert.equal(z.enabled, false);
  assert.deepEqual(await z.findLeadByEmail('a@b.c'), { ok: false, skipped: true, error: 'zoho not configured' });
  assert.deepEqual(await z.createLead({ Email: 'a@b.c' }), { ok: false, skipped: true, error: 'zoho not configured' });
  assert.equal(f.calls.length, 0);
});

test('findLeadByEmail: COQL query, escapes quotes, 204 means none', async () => {
  const f = fakeFetch([TOKEN, { status: 204 }, { body: { data: [{ id: '777' }], info: { count: 1 } } }]);
  const z = createZohoClient({ env: ENV, fetch: f });
  assert.deepEqual(await z.findLeadByEmail("o'brien@x.y"), { ok: true, id: null });
  assert.deepEqual(await z.findLeadByEmail('a@b.c'), { ok: true, id: '777' });
  assert.equal(f.calls[1].url, 'https://api.test/crm/v7/coql');
  const q = JSON.parse(f.calls[1].init.body).select_query;
  assert.match(q, /where Email = 'o\\'brien@x\.y'/);
  assert.equal(f.calls[0].url, 'https://acc.test/oauth/v2/token');
  assert.match(f.calls[0].init.body, /grant_type=refresh_token/);
});

test('createLead posts to /Leads and returns the id; token is cached across calls', async () => {
  const f = fakeFetch([TOKEN, { body: { data: [{ code: 'SUCCESS', details: { id: '111' } }] } }, { body: { data: [{ code: 'SUCCESS', details: { id: '112' } }] } }]);
  const z = createZohoClient({ env: ENV, fetch: f });
  assert.deepEqual(await z.createLead({ Email: 'a@b.c', Last_Name: 'X' }), { ok: true, id: '111' });
  assert.deepEqual(await z.createLead({ Email: 'd@e.f', Last_Name: 'Y' }), { ok: true, id: '112' });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].url, 'https://api.test/crm/v7/Leads');
  assert.equal(f.calls[1].init.method, 'POST');
  assert.equal(f.calls[1].init.headers.Authorization, 'Zoho-oauthtoken AT1');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { data: [{ Email: 'a@b.c', Last_Name: 'X' }], trigger: ['workflow'] });
});

test('updateLead PUTs only the given fields to /Leads/{id}', async () => {
  const f = fakeFetch([TOKEN, { body: { data: [{ code: 'SUCCESS', details: { id: '111' } }] } }]);
  const z = createZohoClient({ env: ENV, fetch: f });
  assert.deepEqual(await z.updateLead('111', { Phone: '1' }), { ok: true, id: '111' });
  assert.equal(f.calls[1].url, 'https://api.test/crm/v7/Leads/111');
  assert.equal(f.calls[1].init.method, 'PUT');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { data: [{ Phone: '1' }], trigger: ['workflow'] });
});

test('addTags uses the add_tags action and never throws', async () => {
  const f = fakeFetch([TOKEN, { body: { data: [{ code: 'SUCCESS', details: { id: '111', tags: [] } }] } }, { status: 500, body: {} }]);
  const z = createZohoClient({ env: ENV, fetch: f });
  assert.equal(await z.addTags('111', ['website', 'resource-download']), true);
  assert.equal(f.calls[1].url, 'https://api.test/crm/v7/Leads/actions/add_tags?ids=111');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { tags: [{ name: 'website' }, { name: 'resource-download' }], over_write: false });
  assert.equal(await z.addTags('111', ['x']), false);
});

test('re-refreshes after expiry (60 s safety margin)', async () => {
  const f = fakeFetch([TOKEN, { status: 204 }, { body: { access_token: 'AT2', expires_in: 3600 } }, { status: 204 }]);
  let t = 0;
  const z = createZohoClient({ env: ENV, fetch: f, now: () => t });
  await z.findLeadByEmail('a@b.c');
  t = 3600_000 - 30_000;
  await z.findLeadByEmail('a@b.c');
  assert.equal(f.calls[3].init.headers.Authorization, 'Zoho-oauthtoken AT2');
});

test('HTTP 200 with per-record error is a failure with details', async () => {
  const f = fakeFetch([TOKEN, { body: { data: [{ code: 'INVALID_DATA', status: 'error', message: 'invalid data', details: { api_name: 'Lead_Source', expected_data_type: 'picklist' } }] } }]);
  const z = createZohoClient({ env: ENV, fetch: f });
  const r = await z.createLead({ Email: 'a@b.c' });
  assert.equal(r.ok, false);
  assert.match(r.error, /INVALID_DATA/);
  assert.match(r.error, /Lead_Source/);
});

test('token endpoint error and network error both return ok:false, never throw; failed token is not cached', async () => {
  const z1 = createZohoClient({ env: ENV, fetch: fakeFetch([{ status: 400, body: { error: 'invalid_code' } }]) });
  const r1 = await z1.createLead({ Email: 'a@b.c' });
  assert.equal(r1.ok, false); assert.match(r1.error, /token/);
  const z2 = createZohoClient({ env: ENV, fetch: fakeFetch([{ throw: new Error('ECONNREFUSED') }]) });
  const r2 = await z2.createLead({ Email: 'a@b.c' });
  assert.equal(r2.ok, false); assert.match(r2.error, /ECONNREFUSED/);
  const f = fakeFetch([{ status: 500, body: {} }, TOKEN, { body: { data: [{ code: 'SUCCESS', details: { id: '9' } }] } }]);
  const z3 = createZohoClient({ env: ENV, fetch: f });
  assert.equal((await z3.createLead({ Email: 'a@b.c' })).ok, false);
  assert.equal((await z3.createLead({ Email: 'a@b.c' })).ok, true);
});

test('a body that never arrives is cut off by the timeout', async () => {
  const slowFetch = async (url, init) => {
    if (String(url).includes('/oauth/')) return new Response(JSON.stringify(TOKEN.body), { status: 200 });
    const stream = new ReadableStream({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode('{"data":[')); init.signal.addEventListener('abort', () => ctrl.error(new Error('aborted'))); } });
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const z = createZohoClient({ env: ENV, fetch: slowFetch, timeoutMs: 100 });
  const started = Date.now();
  const r = await z.createLead({ Email: 'a@b.c' });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - started < 2000, 'must not wait for the body forever');
});

test('addNote posts to Notes with the parent lead', async () => {
  const f = fakeFetch([TOKEN, { body: { data: [{ code: 'SUCCESS', details: { id: 'n1' } }] } }]);
  const z = createZohoClient({ env: ENV, fetch: f });
  assert.equal(await z.addNote('111', 'Repeat', 'body'), true);
  assert.equal(f.calls[1].url, 'https://api.test/crm/v7/Notes');
  const sent = JSON.parse(f.calls[1].init.body);
  assert.deepEqual(sent.data[0].Parent_Id, { module: { api_name: 'Leads' }, id: '111' });
  assert.equal(sent.data[0].Note_Title, 'Repeat');
});
