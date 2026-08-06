'use strict';
/* apollo.test.js — the pure halves of the Apollo integration: ranking,
 * status folding, email-lock detection, normalization. Network functions are
 * only asserted to be inert without a key (no accidental spend from tests). */
const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/apollo');

const p = (title) => ({ title });

test('a security/compliance owner outranks a generic executive', () => {
  assert.ok(A.rank(p('CISO')) > A.rank(p('CEO')));
  assert.ok(A.rank(p('Head of Information Security')) > A.rank(p('Managing Director')));
  assert.ok(A.rank(p('Compliance Manager')) > A.rank(p('Sales Director')));
  assert.ok(A.rank(p('IT Manager')) > A.rank(p('Marketing Manager')));
  assert.ok(A.rank(p('Data Protection Officer')) > A.rank(p('General Manager')));
});

test('an executive outranks an unmatched title, and bad input never throws', () => {
  assert.ok(A.rank(p('CEO')) > A.rank(p('Receptionist')));
  assert.strictEqual(A.rank({}), 0);
  assert.strictEqual(A.rank(null), 0);
});

test('STATUS_MAP folds Apollo vocabulary into the pipeline set', () => {
  assert.strictEqual(A.STATUS_MAP.verified, 'valid');
  assert.strictEqual(A.STATUS_MAP.guessed, 'accept_all');
  assert.strictEqual(A.STATUS_MAP.extrapolated, 'accept_all');
  assert.strictEqual(A.STATUS_MAP.unavailable, 'unknown');
  assert.strictEqual(A.STATUS_MAP.bounced, 'invalid');
  // every output must be a key of store-pg's EMAIL_STATUS map
  const STORE_INPUTS = ['valid', 'accept_all', 'unknown', 'invalid', 'risky'];
  for (const v of Object.values(A.STATUS_MAP)) {
    assert.ok(STORE_INPUTS.includes(v), `${v} would fall through store-pg's map`);
  }
});

test('usableEmail rejects the locked placeholder and empties', () => {
  assert.strictEqual(A.usableEmail('email_not_unlocked@domain.com'), '');
  assert.strictEqual(A.usableEmail(''), '');
  assert.strictEqual(A.usableEmail(null), '');
  assert.strictEqual(A.usableEmail('rashid@gulfreach.ae'), 'rashid@gulfreach.ae');
});

test('normalize returns null until there is a usable email', () => {
  assert.strictEqual(A.normalize(null), null);
  assert.strictEqual(A.normalize({ name: 'X', email: 'email_not_unlocked@d.com' }), null);
  assert.strictEqual(A.normalize({ name: 'X' }), null);
});

test('normalize refuses a known-bad address — it must never displace a working scraped email', () => {
  assert.strictEqual(A.normalize({ name: 'X', email: 'x@y.ae', email_status: 'bounced' }), null);
  assert.strictEqual(A.normalize({ name: 'X', email: 'x@y.ae', email_status: 'do_not_contact' }), null);
});

test('normalize maps a revealed person onto the contact shape', () => {
  const c = A.normalize({
    name: 'Rashid Al Mansoori', first_name: 'Rashid', last_name: 'Al Mansoori',
    title: 'IT Manager', email: 'rashid@gulfreach.ae', email_status: 'verified',
    linkedin_url: 'https://linkedin.com/in/rashid',
  });
  assert.strictEqual(c.email, 'rashid@gulfreach.ae');
  assert.strictEqual(c.name, 'Rashid Al Mansoori');
  assert.strictEqual(c.status, 'valid');
  assert.strictEqual(c.confidence, 95);
  assert.strictEqual(c.linkedin, 'https://linkedin.com/in/rashid');
});

test('normalize composes a name from parts and degrades unknown status', () => {
  const c = A.normalize({ first_name: 'Aisha', last_name: 'Rahman',
    email: 'aisha@x.ae', email_status: 'no_such_status' });
  assert.strictEqual(c.name, 'Aisha Rahman');
  assert.strictEqual(c.status, 'unknown');
  assert.strictEqual(c.confidence, 40);
});

test('confidence ordering follows status quality', () => {
  assert.ok(A.confidenceOf('valid') > A.confidenceOf('accept_all'));
  assert.ok(A.confidenceOf('accept_all') > A.confidenceOf('unknown'));
});

test('search titles cover the buyer set and pass their own ranking regex', () => {
  assert.ok(A.SEARCH_TITLES.includes('CISO'));
  assert.ok(A.SEARCH_TITLES.includes('IT Manager'));
  assert.ok(A.SEARCH_TITLES.includes('CEO'), 'small firms have no IT title at all');
  // every title we ask Apollo for must rank above zero, or the sort is a no-op
  for (const t of A.SEARCH_TITLES) {
    assert.ok(A.rank({ title: t }) > 0, `${t} would rank at 0`);
  }
});

test('network functions are inert without a key or subject (no spend)', async () => {
  assert.strictEqual(await A.findPerson('acme.ae', ''), null);
  assert.strictEqual(await A.findPerson('', 'key'), null);
  assert.strictEqual(await A.enrichByEmail('a@b.ae', ''), 'unverified');
  assert.strictEqual(await A.enrichByEmail('', 'key'), 'unverified');
  assert.strictEqual(await A.enrichOrg('acme.ae', ''), null);
  assert.strictEqual(await A.enrichOrg('', 'key'), null);
  // reveal without an id degrades to the pure normalize path — no network
  assert.strictEqual(await A.reveal(null, 'key'), null);
  const already = await A.reveal({ email: 'x@y.ae', email_status: 'verified' }, 'key');
  assert.strictEqual(already.status, 'valid');
});

test('qs builds bracket-array query strings the current API expects', () => {
  const q = A.qs({
    q_organization_domains_list: ['acme.ae'],
    person_titles: ['CISO', 'IT Manager'],
    per_page: 10,
    empty: '', missing: null,
  });
  assert.match(q, /q_organization_domains_list%5B%5D=acme\.ae/);
  assert.match(q, /person_titles%5B%5D=CISO/);
  assert.match(q, /person_titles%5B%5D=IT\+Manager/);
  assert.match(q, /per_page=10/);
  assert.ok(!q.includes('empty') && !q.includes('missing'), 'blank params must be dropped');
});

test("STATUS_MAP treats the docs' open-string statuses conservatively", () => {
  // current docs enumerate only these four for the search filter — everything
  // else must degrade to 'unknown' via the map's default path
  assert.strictEqual(A.STATUS_MAP.verified, 'valid');
  assert.strictEqual(A.STATUS_MAP.unverified, 'unknown');
  assert.strictEqual(A.STATUS_MAP.unavailable, 'unknown');
  assert.strictEqual(A.STATUS_MAP['likely to engage'], 'valid');
});

test("verdictOf only returns definitive verdicts — Apollo's no-data statuses become the 'unverified' sentinel", () => {
  // run.js's refresh pass skips ONLY on 'unverified'; anything else re-stamps
  // verified_at. So "Apollo has no data" (raw unverified/unavailable/missing/
  // unrecognised) must fold to the sentinel, never to 'unknown'.
  assert.strictEqual(A.verdictOf('verified'), 'valid');
  assert.strictEqual(A.verdictOf('likely to engage'), 'valid');
  assert.strictEqual(A.verdictOf('guessed'), 'accept_all');
  assert.strictEqual(A.verdictOf('bounced'), 'invalid');
  assert.strictEqual(A.verdictOf('do_not_contact'), 'invalid');
  assert.strictEqual(A.verdictOf('unverified'), 'unverified');
  assert.strictEqual(A.verdictOf('unavailable'), 'unverified');
  assert.strictEqual(A.verdictOf('no_such_status'), 'unverified');
  assert.strictEqual(A.verdictOf(undefined), 'unverified');
  assert.strictEqual(A.verdictOf(null), 'unverified');
});

test('isPlanError recognises the paywall and nothing else', () => {
  assert.ok(A.isPlanError(new Error('HTTP 403 for … :: {"error":"…","error_code":"API_INACCESSIBLE"}')));
  assert.ok(A.isPlanError(new Error('The api/v1/people/match API is not included in your Free plan')));
  assert.ok(!A.isPlanError(new Error('HTTP 429 for … rate limit')));
  assert.ok(!A.isPlanError(new Error('fetch failed')));
  assert.ok(!A.isPlanError(null));
});

test('the plan latch makes every people call a no-op, without touching org enrich', async () => {
  A._setPlanBlocked(true);
  try {
    assert.strictEqual(A.planBlocked(), true);
    // a key IS present here — only the latch stops these (and with no network,
    // a real call would throw/fail the test rather than return cleanly)
    assert.strictEqual(await A.findPerson('acme.ae', 'key'), null);
    assert.strictEqual(await A.enrichByEmail('a@b.ae', 'key'), 'unverified');
    const c = await A.reveal({ id: 'x', email: 'x@y.ae', email_status: 'verified' }, 'key');
    assert.strictEqual(c.status, 'valid', 'reveal degrades to the pure normalize path');
  } finally {
    A._setPlanBlocked(false);
  }
});

test('sizeBandOf maps headcount onto the crm_prospects CHECK values', () => {
  assert.strictEqual(A.sizeBandOf(12), 'sub30');
  assert.strictEqual(A.sizeBandOf(30), 'sme');
  assert.strictEqual(A.sizeBandOf(249), 'sme');
  assert.strictEqual(A.sizeBandOf(250), 'midmarket');
  assert.strictEqual(A.sizeBandOf(999), 'midmarket');
  assert.strictEqual(A.sizeBandOf(14000), 'enterprise');
  assert.strictEqual(A.sizeBandOf(0), null);
  assert.strictEqual(A.sizeBandOf(null), null);
  assert.strictEqual(A.sizeBandOf('big'), null);
});

test('isCreditError spots an empty balance and nothing else', () => {
  assert.ok(A.isCreditError(new Error('HTTP 422 … {"error":"You have insufficient credits! <a href=…"}')));
  assert.ok(!A.isCreditError(new Error('HTTP 403 … API_INACCESSIBLE')));
  assert.ok(!A.isCreditError(new Error('fetch failed')));
  assert.ok(!A.isCreditError(null));
});

test('the org latch stops enrichment without touching the people latch', async () => {
  A._setOrgBlocked(true);
  try {
    assert.strictEqual(A.orgCreditsBlocked(), true);
    // a key IS present — only the latch stops this, and with no network a
    // real call would throw rather than return cleanly
    assert.strictEqual(await A.enrichOrg('acme.ae', 'key'), null);
    assert.strictEqual(A.planBlocked(), false, 'the two latches are independent');
  } finally {
    A._setOrgBlocked(false);
  }
});

test('the two latches are independent in the other direction too', async () => {
  A._setPlanBlocked(true);
  try {
    assert.strictEqual(A.orgCreditsBlocked(), false,
      'a people paywall must not disable org enrichment — it is the one endpoint Free allows');
  } finally {
    A._setPlanBlocked(false);
  }
});
