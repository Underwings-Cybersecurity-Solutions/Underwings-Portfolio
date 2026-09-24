import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncLead } from './lead-sync.ts';
import { createZohoClient } from './zoho.ts';
import { buildContactLead, buildNewsletterLead } from './zoho-leads.ts';

const ENV = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt', accountsUrl: 'https://acc.test', apiUrl: 'https://api.test', ownerId: 'o1' };
const TOKEN = { body: { access_token: 'AT1', expires_in: 3600 } };
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = script.shift();
    if (!step) throw new Error('unexpected fetch ' + url);
    if (step.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(step.body), { status: step.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}
function fakeSupabase() {
  const updates = [];
  const sb = { from: (table) => ({ update: (patch) => ({ eq: async (col, val) => { updates.push({ table, patch, col, val }); return { error: null }; } }) }) };
  sb.updates = updates;
  return sb;
}

test('new email → create with the full insert payload, write back the id', async () => {
  const f = fakeFetch([TOKEN, { status: 204 }, { body: { data: [{ code: 'SUCCESS', details: { id: '500' } }] } }]);
  const client = createZohoClient({ env: ENV, fetch: f });
  const sb = fakeSupabase();
  const payload = buildContactLead({ name: 'Ahmed Khan', email: 'a@b.co', company: 'ACME', message: 'hello', recordId: 'r1', attribution: {} }, 'o1');
  const r = await syncLead({ supabase: sb, table: 'form_submissions', recordId: 'r1', form: 'Contact', payload, repeatDetails: 'x', client });
  assert.deepEqual(r, { ok: true, id: '500', action: 'insert' });
  const sent = JSON.parse(f.calls[2].init.body).data[0];
  assert.equal(sent.Lead_Status, 'Not Contacted'); assert.equal(sent.Description, 'hello'); assert.deepEqual(sent.Owner, { id: 'o1' });
  assert.equal(sb.updates.length, 1);
  assert.equal(sb.updates[0].patch.zoho_lead_id, '500');
  assert.equal(sb.updates[0].patch.zoho_error, null);
});

test('existing email → PATCH only the update-safe subset, add tags and a Note; never status/owner/description', async () => {
  const f = fakeFetch([
    TOKEN,
    { body: { data: [{ id: '777' }] } },                                   // coql: exists
    { body: { data: [{ code: 'SUCCESS', details: { id: '777' } }] } },     // PUT /Leads/777
    { body: { data: [{ code: 'SUCCESS', details: { id: '777' } }] } },     // add_tags
    { body: { data: [{ code: 'SUCCESS', details: { id: 'n1' } }] } },      // note
  ]);
  const client = createZohoClient({ env: ENV, fetch: f });
  const sb = fakeSupabase();
  const payload = buildNewsletterLead({ email: 'a@b.co', source: 'lead_magnet:Security Assessment Checklist', recordId: 'n2', attribution: { utm_source: 'later' } }, 'o1');
  const r = await syncLead({ supabase: sb, table: 'subscribers', recordId: 'n2', form: 'Resource Download', payload, repeatDetails: 'Downloaded the checklist', client });
  assert.deepEqual(r, { ok: true, id: '777', action: 'update' });
  assert.equal(f.calls[2].url, 'https://api.test/crm/v7/Leads/777');
  assert.equal(f.calls[2].init.method, 'PUT');
  const sent = JSON.parse(f.calls[2].init.body).data[0];
  assert.deepEqual(Object.keys(sent).sort(), ['Resource_Downloaded', 'Website_Form', 'Website_Record_ID']);
  assert.match(f.calls[3].url, /add_tags\?ids=777$/);
  assert.deepEqual(JSON.parse(f.calls[3].init.body).tags, [{ name: 'website' }, { name: 'resource-download' }]);
  const note = JSON.parse(f.calls[4].init.body).data[0];
  assert.equal(note.Note_Title, 'Website: repeat Resource Download');
  assert.match(note.Note_Content, /Downloaded the checklist/);
  assert.equal(sb.updates[0].patch.zoho_lead_id, '777');
});

test('lookup failure → ok:false, nothing created, zoho_error written and attempts incremented', async () => {
  const f = fakeFetch([TOKEN, { status: 500, body: { code: 'INTERNAL_ERROR' } }]);
  const client = createZohoClient({ env: ENV, fetch: f });
  const sb = fakeSupabase();
  const payload = buildContactLead({ email: 'a@b.co', recordId: 'r1', attribution: {} }, 'o1');
  const r = await syncLead({ supabase: sb, table: 'form_submissions', recordId: 'r1', form: 'Contact', payload, repeatDetails: '', client, attempts: 2 });
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 2);
  assert.match(sb.updates[0].patch.zoho_error, /INTERNAL_ERROR/);
  assert.equal(sb.updates[0].patch.zoho_attempts, 3);
});

test('invalid email is a permanent failure: no Zoho call, attempts jumps to the give-up value', async () => {
  const f = fakeFetch([]);
  const client = createZohoClient({ env: ENV, fetch: f });
  const sb = fakeSupabase();
  const payload = buildContactLead({ email: 'abc@d', recordId: 'r1', attribution: {} }, 'o1');
  const r = await syncLead({ supabase: sb, table: 'form_submissions', recordId: 'r1', form: 'Contact', payload, repeatDetails: '', client });
  assert.equal(r.ok, false); assert.equal(r.permanent, true);
  assert.equal(f.calls.length, 0);
  assert.equal(sb.updates[0].patch.zoho_attempts, 99);
});

test('client disabled → skipped, no Supabase write', async () => {
  const client = createZohoClient({ env: {}, fetch: fakeFetch([]) });
  const sb = fakeSupabase();
  const payload = buildContactLead({ email: 'a@b.co', recordId: 'r1', attribution: {} }, '');
  const r = await syncLead({ supabase: sb, table: 'form_submissions', recordId: 'r1', form: 'Contact', payload, repeatDetails: '', client });
  assert.deepEqual(r, { ok: false, skipped: true, error: 'zoho not configured' });
  assert.equal(sb.updates.length, 0);
});
