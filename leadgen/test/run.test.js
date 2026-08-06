'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../run');

test('keysOf returns both forms a candidate can be known by', () => {
  assert.deepStrictEqual(R.keysOf({ company: 'Acme LLC', domain: 'acme.ae' }),
    ['d:acme.ae', 'c:acme']);
  assert.deepStrictEqual(R.keysOf({ company: 'Acme LLC' }), ['c:acme']);
  assert.deepStrictEqual(R.keysOf({}), []);
});

test('dedupeCandidates drops anything matching EITHER key', () => {
  const seen = new Set(['d:known.ae']);
  const out = R.dedupeCandidates([
    { company: 'Known', domain: 'known.ae' },        // by domain
    { company: 'Fresh', domain: 'fresh.ae' },
    { company: 'Fresh', domain: 'fresh-two.ae' },    // same normalised name
    { company: 'Other' },
  ], seen);
  assert.deepStrictEqual(out.map((c) => c.company), ['Fresh', 'Other']);
});

test('dedupeCandidates treats the seen set as read-only', () => {
  const seen = new Set(['d:known.ae']);
  R.dedupeCandidates([{ company: 'Fresh', domain: 'fresh.ae' }], seen);
  assert.deepStrictEqual([...seen], ['d:known.ae']);
});

test('interleave round-robins so one prolific source cannot starve the rest', () => {
  const out = R.interleave({
    wikidata: [{ company: 'w1' }, { company: 'w2' }, { company: 'w3' }],
    overpass: [{ company: 'o1' }],
    news: [{ company: 'n1' }, { company: 'n2' }],
  });
  assert.deepStrictEqual(out.map((c) => c.company),
    ['w1', 'o1', 'n1', 'w2', 'n2', 'w3']);
});

test('interleave ignores empty and missing source lists', () => {
  assert.deepStrictEqual(R.interleave({ a: [], b: null, c: [{ company: 'x' }] }),
    [{ company: 'x' }]);
  assert.deepStrictEqual(R.interleave({}), []);
});

const TODAY = '2026-08-02';
const OPTS = { reverifyAfterDays: 30, maxRows: 25, today: TODAY };

test('pickRefreshables re-verifies stale, still-plausible emails', () => {
  const { reverify, recontact } = R.pickRefreshables([
    { id: 'a', prospectId: 'p1', email: 'a@x.ae', emailStatus: 'verified', verifiedAt: '2026-06-01', addedAt: '2026-06-01' },
    { id: 'b', prospectId: 'p2', email: 'b@x.ae', emailStatus: 'verified', verifiedAt: TODAY, addedAt: '2026-06-01' },
  ], OPTS);
  assert.deepStrictEqual(reverify.map((r) => r.id), ['a']);
  assert.deepStrictEqual(recontact, []);
});

test('pickRefreshables never retries an invalid email', () => {
  const { reverify, recontact } = R.pickRefreshables([
    { id: 'a', email: 'a@x.ae', emailStatus: 'invalid', verifiedAt: '2026-01-01', addedAt: '2026-01-01', website: 'https://x.ae' },
  ], OPTS);
  // flagged forever, never re-verified — but it has no contact name, so it is
  // still eligible for a contact retry
  assert.deepStrictEqual(reverify, []);
  assert.deepStrictEqual(recontact.map((r) => r.id), ['a']);
});

test('pickRefreshables retries contacts only for rows with a website and no name', () => {
  const { recontact } = R.pickRefreshables([
    { id: 'a', prospectId: 'p1', website: 'https://a.ae', addedAt: '2026-01-01' },
    { id: 'b', prospectId: 'p2', website: 'https://b.ae', contactName: 'Someone', addedAt: '2026-01-01' },
    { id: 'c', prospectId: 'p3', addedAt: '2026-01-01' },                     // no website
  ], OPTS);
  assert.deepStrictEqual(recontact.map((r) => r.id), ['a']);
  assert.strictEqual(recontact[0].domain, 'a.ae');
});

test('pickRefreshables buckets are disjoint and honour maxRows', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: `r${i}`, prospectId: `p${i}`, website: 'https://x.ae', addedAt: '2026-01-01',
  }));
  const { reverify, recontact } = R.pickRefreshables(rows, { ...OPTS, maxRows: 25 });
  assert.strictEqual(reverify.length + recontact.length, 25);
  const ids = new Set([...reverify, ...recontact].map((r) => r.id));
  assert.strictEqual(ids.size, 25, 'a record must not appear in both buckets');
});

test('pickRefreshables falls back to addedAt when never verified', () => {
  const { recontact } = R.pickRefreshables([
    { id: 'fresh', prospectId: 'p', website: 'https://x.ae', addedAt: TODAY },
    { id: 'stale', prospectId: 'p', website: 'https://x.ae', addedAt: '2026-01-01' },
  ], OPTS);
  assert.deepStrictEqual(recontact.map((r) => r.id), ['stale']);
});

test('selectLeads keeps customers above threshold and caps the partner trickle', () => {
  const L = (kind, icp_score, company) => ({ kind, icp_score, company });
  const scored = [
    L('customer', 9, 'c9'), L('customer', 6, 'c6'), L('customer', 5, 'c5'),
    L('partner', 9, 'p9'), L('partner', 8, 'p8'), L('partner', 7, 'p7'),
    L('partner', 6, 'p6'), L('partner', 3, 'p3'),
  ];
  const out = R.selectLeads(scored, { threshold: 6, partnerThreshold: 6, partnerCap: 2 });
  assert.deepStrictEqual(out.map((l) => l.company), ['c9', 'c6', 'p9', 'p8']);
});

test('selectLeads treats an unlabelled lead as a customer', () => {
  const out = R.selectLeads([{ icp_score: 8, company: 'x' }],
    { threshold: 6, partnerThreshold: 6, partnerCap: 5 });
  assert.deepStrictEqual(out.map((l) => l.company), ['x']);
});

test('a partner never displaces a customer, and an empty pool is fine', () => {
  assert.deepStrictEqual(R.selectLeads([], { partnerCap: 5 }), []);
  const onlyPartners = R.selectLeads(
    [{ kind: 'partner', icp_score: 10, company: 'p' }],
    { threshold: 6, partnerThreshold: 6, partnerCap: 5 });
  assert.deepStrictEqual(onlyPartners.map((l) => l.company), ['p']);
});
