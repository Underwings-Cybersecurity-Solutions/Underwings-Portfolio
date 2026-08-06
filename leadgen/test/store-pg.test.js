'use strict';
/* store-pg.test.js — the pure mapping layer between a pipeline lead and the
 * crm_prospects / crm_prospect_contacts rows. Every value asserted here has a
 * CHECK constraint behind it in migration 011, so a regression means a failed
 * INSERT at 3am, not a subtly wrong UI. */
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/store-pg');

test('idOf prefers the domain, falls back to a normalised company name', () => {
  assert.strictEqual(S.idOf({ website: 'https://www.Acme.ae/x' }), 'd:acme.ae');
  assert.strictEqual(S.idOf({ company: 'Acme  Trading L.L.C.' }), 'c:acmetrading');
  assert.strictEqual(S.idOf({}), 'c:');
});

test('toProspectRow maps a scored lead onto the CRM columns', () => {
  const row = S.toProspectRow({
    company: 'Alpha Clinic', website: 'https://alphaclinic.ae',
    country: 'United Arab Emirates', industry: 'Healthcare',
    service: 'GRC / ISO 27001', icp_score: 9, why: 'ADHICS deadline',
    signal: 'opened a third branch', source: 'overpass', location: 'Dubai, UAE',
  });
  assert.strictEqual(row.company_name, 'Alpha Clinic');
  assert.strictEqual(row.domain, 'alphaclinic.ae');
  assert.strictEqual(row.geo_bucket, 'uae');
  assert.strictEqual(row.emirate, 'Dubai');
  assert.strictEqual(row.ai_score, 9);
  assert.strictEqual(row.dedupe_key, 'd:alphaclinic.ae');
  assert.strictEqual(row.size_band, null, 'no headcount known → null, not a guess');
  // the pipeline seeds 'new' and nothing else — sales owns everything after
  assert.strictEqual(row.status, 'new');
  assert.strictEqual(row.enrichment_status, 'enriched');
});

test('an unverified email never claims a verified_at', () => {
  const a = S.toProspectRow({ company: 'X', emailStatus: 'unverified' });
  assert.strictEqual(a.verified_at, null);
  const b = S.toProspectRow({ company: 'X', emailStatus: 'valid' });
  assert.ok(b.verified_at, 'a real verification result should stamp verified_at');
});

test('geo_bucket defaults to uae when Claude returned no country', () => {
  assert.strictEqual(S.toProspectRow({ company: 'X' }).geo_bucket, 'uae');
  assert.strictEqual(S.toProspectRow({ company: 'X', country: 'Germany' }).geo_bucket, 'global');
  assert.strictEqual(S.toProspectRow({ company: 'X', country: 'Qatar' }).geo_bucket, 'gcc');
});

test('emirateOf recognises every emirate and tolerates spacing', () => {
  assert.strictEqual(S.emirateOf('Sheikh Zayed Rd, Dubai'), 'Dubai');
  assert.strictEqual(S.emirateOf('Al Ain, Abu  Dhabi'), 'Abu Dhabi');
  assert.strictEqual(S.emirateOf('RasAlKhaimah'), 'Ras Al Khaimah');
  assert.strictEqual(S.emirateOf('London'), null);
  assert.strictEqual(S.emirateOf(''), null);
});

test('contactEmailStatus only says "verified" when Hunter actually verified', () => {
  assert.strictEqual(S.contactEmailStatus({ emailStatus: 'valid' }), 'verified');
  assert.strictEqual(S.contactEmailStatus({ emailStatus: 'accept_all' }), 'probable');
  assert.strictEqual(S.contactEmailStatus({ emailStatus: 'unknown' }), 'low');
  assert.strictEqual(S.contactEmailStatus({ emailStatus: 'invalid' }), 'invalid');
  // scraped, unverified role inbox
  assert.strictEqual(S.contactEmailStatus({ emailStatus: 'unverified', email: 'info@acme.ae' }), 'role');
  // scraped, unverified personal-looking address
  assert.strictEqual(S.contactEmailStatus({ emailStatus: 'unverified', email: 'j.smith@acme.ae' }), 'low');
});

test('every contactEmailStatus output satisfies the email_status CHECK', () => {
  const ALLOWED = ['verified', 'probable', 'role', 'low', 'risky', 'invalid'];
  const inputs = [
    { emailStatus: 'valid' }, { emailStatus: 'accept_all' }, { emailStatus: 'unknown' },
    { emailStatus: 'invalid' }, { emailStatus: 'risky' }, { emailStatus: 'unverified', email: 'a@b.ae' },
    { emailStatus: '', email: 'sales@b.ae' }, { email: 'x@y.ae' }, {},
  ];
  for (const i of inputs) assert.ok(ALLOWED.includes(S.contactEmailStatus(i)), JSON.stringify(i));
});

test('contactSource satisfies the source CHECK and reflects reality', () => {
  // mirrors migration 012's CHECK ('hunter' remains valid for pre-switch rows)
  const ALLOWED = ['scrape', 'hunter', 'apollo', 'pattern', 'search'];
  assert.strictEqual(S.contactSource({ contactName: 'A Person', email: 'a@b.ae' }), 'apollo');
  assert.strictEqual(S.contactSource({ email: 'info@b.ae' }), 'scrape');
  assert.strictEqual(S.contactSource({ phone: '+9714' }), 'search');
  for (const i of [{ contactName: 'x' }, { email: 'x' }, {}]) {
    assert.ok(ALLOWED.includes(S.contactSource(i)));
  }
});

test('toContactRow returns null when we know no one at all', () => {
  assert.strictEqual(S.toContactRow({ company: 'X' }, 'pid'), null);
  assert.ok(S.toContactRow({ company: 'X', phone: '+97141234567' }, 'pid'));
});

test('toContactRow carries Hunter confidence through', () => {
  const c = S.toContactRow({
    contactName: 'Aisha Rahman', title: 'CISO', email: 'aisha@acme.ae',
    emailStatus: 'valid', linkedin: 'https://linkedin.com/in/x', confidence: 92,
  }, 'pid-1');
  assert.strictEqual(c.prospect_id, 'pid-1');
  assert.strictEqual(c.email_status, 'verified');
  assert.strictEqual(c.confidence, 92);
  assert.strictEqual(c.linkedin_url, 'https://linkedin.com/in/x');
});

test('the field allowlists keep sales and pipeline columns disjoint', () => {
  // The same split is enforced in Postgres by migration 011's column grants.
  // If these ever overlap, the pipeline could stomp a human's notes.
  const overlap = S.SALES_FIELDS.filter((f) => S.ENRICHMENT_FIELDS.includes(f));
  assert.deepStrictEqual(overlap, []);
  assert.ok(S.SALES_FIELDS.includes('status') && S.SALES_FIELDS.includes('notes'));
  assert.ok(!S.ENRICHMENT_FIELDS.includes('status'));
  assert.ok(!S.ENRICHMENT_FIELDS.includes('notes'));
  // this list must match the GRANT UPDATE in migrations 016 + 017 exactly —
  // a column granted to `authenticated` but missing here is one the pipeline
  // would happily overwrite on the next refresh pass
  for (const t of ['touch_call', 'touch_mail', 'touch_msg', 'touch_li', 'touch_follow']) {
    assert.ok(S.SALES_FIELDS.includes(t), `${t} is sales-owned but not in the allowlist`);
  }
});

test('toRecord round-trips a CRM row plus its best contact', () => {
  const r = S.toRecord({
    id: 'uuid-1', dedupe_key: 'd:acme.ae', company_name: 'Acme',
    website: 'https://acme.ae', ai_score: 7, status: 'new',
    created_at: '2026-08-01T10:00:00Z', verified_at: '2026-08-02T10:00:00Z',
    country: 'United Arab Emirates', geo_bucket: 'uae', service: 'Cloud Security',
  }, { name: 'Aisha', job_title: 'CISO', email: 'a@acme.ae', email_status: 'verified' });
  assert.strictEqual(r.id, 'd:acme.ae');
  assert.strictEqual(r.prospectId, 'uuid-1');
  assert.strictEqual(r.addedAt, '2026-08-01');
  assert.strictEqual(r.verifiedAt, '2026-08-02');
  assert.strictEqual(r.contactName, 'Aisha');
});

test('toRecord tolerates a prospect with no contact at all', () => {
  const r = S.toRecord({ id: 'u', dedupe_key: 'c:x', company_name: 'X', status: 'new' });
  assert.strictEqual(r.email, '');
  assert.strictEqual(r.contactName, '');
  assert.strictEqual(r.addedAt, '');
});

test('setContactStatus refuses non-verdicts and incomplete keys without touching the network', async () => {
  // 'unverified' is the "Apollo could not say" sentinel, not a status — the
  // refresh pass must never write it over a contact's real email_status.
  assert.strictEqual(await S.setContactStatus('pid-1', 'a@b.ae', 'unverified'), false);
  assert.strictEqual(await S.setContactStatus('pid-1', 'a@b.ae', 'no_such'), false);
  assert.strictEqual(await S.setContactStatus('', 'a@b.ae', 'valid'), false);
  assert.strictEqual(await S.setContactStatus('pid-1', '', 'valid'), false);
});

test('the primary outranks its own extras, so it stays "the" contact', () => {
  // confidence.desc.nullslast decides which row the CRM shows; a null on the
  // primary put the address bestEmail() chose BELOW the ones it rejected
  const rows = S.toContactRows({ email: 'info@acme.ae', emails: ['a@acme.ae', 'b@acme.ae'] }, 'p');
  assert.strictEqual(rows[0].email, 'info@acme.ae');
  for (const r of rows.slice(1)) assert.ok(rows[0].confidence > r.confidence);
});

test('a big site cannot flood the drawer with every branch inbox', () => {
  const emails = Array.from({ length: 40 }, (_, i) => `p${i}@acme.ae`);
  emails.push('info@acme.ae');   // a role inbox buried at the end
  const rows = S.toContactRows({ email: 'sales@acme.ae', emails }, 'p', 5);
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(rows[0].email, 'sales@acme.ae', 'primary is always kept');
  // role addresses survive the cut ahead of the generic ones
  assert.ok(rows.some((r) => r.email === 'info@acme.ae'));
});

test('toContactRows keeps every harvested email and phone, ranked below the primary', () => {
  const rows = S.toContactRows({
    contactName: 'Aisha Rahman', title: 'CISO', email: 'aisha@acme.ae',
    emailStatus: 'valid', confidence: 92,
    emails: ['aisha@acme.ae', 'info@acme.ae', 'careers@acme.ae'],
    phone: '+97141111111', phones: ['+97141111111', '+97142222222'],
  }, 'pid-1');
  assert.strictEqual(rows.length, 3, 'primary + two extra addresses');
  assert.strictEqual(rows[0].email, 'aisha@acme.ae');
  assert.strictEqual(rows[0].confidence, 92);
  // the primary's own address must not be duplicated as an extra
  assert.strictEqual(rows.filter((r) => r.email === 'aisha@acme.ae').length, 1);
  const info = rows.find((r) => r.email === 'info@acme.ae');
  assert.strictEqual(info.email_status, 'role');
  assert.ok(info.confidence < rows[0].confidence, 'extras rank below the primary');
  // the second phone rides along rather than being dropped
  assert.ok(rows.some((r) => r.phone === '+97142222222'));
  for (const r of rows) assert.strictEqual(r.prospect_id, 'pid-1');
});

test('toContactRows is case-insensitive about duplicate addresses', () => {
  const rows = S.toContactRows(
    { email: 'Info@Acme.ae', emails: ['info@acme.ae', 'INFO@ACME.AE'] }, 'p');
  assert.strictEqual(rows.length, 1);
});

test('toContactRows returns nothing when the company is a blank', () => {
  assert.deepStrictEqual(S.toContactRows({}, 'p'), []);
  assert.deepStrictEqual(S.toContactRows({ emails: [], phones: [] }, 'p'), []);
});

test('a phone-only lead still produces a contact row', () => {
  const rows = S.toContactRows({ phone: '+97143333333', phones: ['+97143333333'] }, 'p');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].phone, '+97143333333');
  assert.strictEqual(rows[0].email, null);
});

test('kind reaches the prospect row and defaults to customer', () => {
  assert.strictEqual(S.toProspectRow({ company: 'X', kind: 'partner' }).kind, 'partner');
  assert.strictEqual(S.toProspectRow({ company: 'X' }).kind, 'customer');
  assert.strictEqual(S.toProspectRow({ company: 'X', kind: 'nonsense' }).kind, 'customer');
});

test('addresses are stored lower-cased so migration 015 dedupes them', () => {
  // the uniqueness index is on the plain column, so normalisation here is
  // what makes Info@X.AE and info@x.ae the same contact
  const rows = S.toContactRows({ email: 'Info@Acme.AE', emails: ['INFO@ACME.ae'] }, 'p');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].email, 'info@acme.ae');
  assert.strictEqual(S.toContactRow({ email: ' Sales@Acme.AE ' }, 'p').email, 'sales@acme.ae');
});
