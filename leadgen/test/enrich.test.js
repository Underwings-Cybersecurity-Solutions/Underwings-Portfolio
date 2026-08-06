'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildPrompt, mergeAssessments, isNamedCompany, TOOL } = require('../lib/enrich');
const cfg = require('../config');

test('prompt carries the Underwings ICP, sectors and service lines', () => {
  const p = buildPrompt([{ company: 'Acme Clinic', source: 'overpass' }]);
  assert.match(p, /Underwings/);
  assert.match(p, /UAE cybersecurity/);
  assert.match(p, /ISO 27001/);
  assert.match(p, /PTaaS/);
  for (const s of cfg.icp.services) assert.ok(p.includes(s), `missing service line: ${s}`);
  for (const s of cfg.icp.sectors) assert.ok(p.includes(s), `missing sector: ${s}`);
  assert.match(p, /\[0\] company="Acme Clinic"/);
});

test('prompt routes vendors into the partner track instead of dropping them', () => {
  const p = buildPrompt([{ company: 'X', source: 'y' }]);
  // the old prompt binned these as "competitors, not buyers"; they are now
  // referral and white-label channels, which is the whole partner track
  assert.match(p, /kind='partner'/);
  assert.match(p, /managed-service providers|system integrators/);
  assert.match(p, /referral and white-label channels/);
  // keep=false must now be reserved for genuine noise
  assert.match(p, /keep=false ONLY for individuals, job listings/);
  assert.match(p, /Do NOT invent contact names/);
});

test('a direct competitor is kept as a low-scoring partner, not discarded', () => {
  const p = buildPrompt([{ company: 'X', source: 'y' }]);
  assert.match(p, /direct\s+competitor: kind='partner' with a LOW score/);
});

test('mergeAssessments defaults an unlabelled or bogus kind to customer', () => {
  const batch = [{ company: 'Acme IT' }, { company: 'Beta Clinic' }, { company: 'Gamma Bank' }];
  const { leads } = mergeAssessments(batch, [
    { index: 0, keep: true, kind: 'partner', icp_score: 7, service: '', company: 'Acme IT' },
    { index: 1, keep: true, icp_score: 7, service: '', company: 'Beta Clinic' },
    { index: 2, keep: true, kind: 'nonsense', icp_score: 7, service: '', company: 'Gamma Bank' },
  ]);
  assert.deepStrictEqual(leads.map((l) => l.kind), ['partner', 'customer', 'customer']);
});

test('prompt asks Claude to infer the company behind a bare news signal', () => {
  const p = buildPrompt([{ company: '', source: 'google-news', signal: 'Bank X breached' }]);
  assert.match(p, /\(unknown — infer from signal\)/);
  assert.match(p, /signal="Bank X breached"/);
});

test('tool schema requires the fields the store needs', () => {
  const req = TOOL.input_schema.properties.leads.items.required;
  for (const k of ['index', 'company', 'service', 'kind', 'icp_score', 'why', 'keep']) {
    assert.ok(req.includes(k), `tool schema must require ${k}`);
  }
});

const BATCH = [
  { company: 'Alpha Clinic', source: 'overpass', location: 'Dubai' },
  { company: 'Beta Freight', source: 'wikidata' },
  { company: 'Gamma Security', source: 'websearch' },
];

test('mergeAssessments keeps only keep=true and validates the enums', () => {
  const { leads } = mergeAssessments(BATCH, [
    { index: 0, company: 'Alpha Clinic LLC', country: 'United Arab Emirates', industry: 'Healthcare', service: 'GRC / ISO 27001', icp_score: 9, why: 'ADHICS', keep: true },
    { index: 1, company: 'Beta Freight', country: 'UAE', industry: 'NOT A SECTOR', service: 'NOT A SERVICE', icp_score: 7, why: 'growth', keep: true },
    { index: 2, company: 'Gamma Security', icp_score: 2, why: 'competitor', keep: false },
  ]);
  assert.strictEqual(leads.length, 2);
  assert.strictEqual(leads[0].company, 'Alpha Clinic LLC');
  assert.strictEqual(leads[0].industry, 'Healthcare');
  assert.strictEqual(leads[0].geoBucket, 'uae');
  // an invalid enum is blanked, never stored as junk
  assert.strictEqual(leads[1].service, '');
  assert.strictEqual(leads[1].industry, '');
});

test('a candidate with NO assessment is not reported as assessed', () => {
  // This is the bug fix: run.js only writes `assessed` into seen.json, so a
  // candidate lost to a failed Claude batch is retried next cycle instead of
  // being blacklisted forever.
  const { leads, assessed } = mergeAssessments(BATCH, [
    { index: 0, company: 'Alpha Clinic', service: 'Cloud Security', icp_score: 8, why: 'x', keep: true },
  ]);
  assert.strictEqual(leads.length, 1);
  assert.deepStrictEqual(assessed.map((c) => c.company), ['Alpha Clinic']);
});

test('an entirely failed batch assesses nothing', () => {
  const { leads, assessed } = mergeAssessments(BATCH, []);
  assert.deepStrictEqual(leads, []);
  assert.deepStrictEqual(assessed, []);
});

test('a rejected candidate IS assessed (remembered, so we stop re-billing it)', () => {
  const { leads, assessed } = mergeAssessments(BATCH, [
    { index: 2, company: 'Gamma Security', service: 'Cloud Security', icp_score: 1, why: 'competitor', keep: false },
  ]);
  assert.deepStrictEqual(leads, []);
  assert.deepStrictEqual(assessed.map((c) => c.company), ['Gamma Security']);
});

test('a non-numeric score degrades to 0 rather than NaN', () => {
  const { leads } = mergeAssessments([BATCH[0]], [
    { index: 0, company: 'Alpha', service: 'Cloud Security', icp_score: 'high', why: 'x', keep: true },
  ]);
  assert.strictEqual(leads[0].icp_score, 0);
});

test("country falls back to the source's location, and '?' still buckets", () => {
  const { leads } = mergeAssessments([BATCH[0]], [
    { index: 0, company: 'Alpha', service: 'Cloud Security', icp_score: 8, why: 'x', keep: true },
  ]);
  assert.strictEqual(leads[0].country, 'Dubai');
  const { leads: l2 } = mergeAssessments([BATCH[1]], [
    { index: 0, company: 'Beta', country: 'United Arab Emirates?', service: 'Cloud Security', icp_score: 8, why: 'x', keep: true },
  ]);
  assert.strictEqual(l2[0].geoBucket, 'uae');
});

test('a dual-fit firm is steered to the partner track, not the customer one', () => {
  const p = buildPrompt([{ company: 'X', source: 'y' }]);
  // an IT services company could buy AND refer; the referral channel is
  // worth more than the single sale, so the prompt must break the tie
  assert.match(p, /TIE-BREAK/);
  assert.match(p, /Prefer kind='partner' for \s*these/);
});

test('a collective is never a prospect, however high it scores', () => {
  // these four all reached the CRM scoring 6-9 and sat at the top of the
  // sales list; not one of them can be emailed
  for (const n of ['UAE organisations (Handala breach victims)',
                   'Three major UAE organisations (breach incident)',
                   'UAE Private Sector (Privacy Breach Victims)',
                   'Abu Dhabi organisations (data leak incident)',
                   'Several unnamed UAE banks', 'undisclosed healthcare provider',
                   '', '  ', '12345']) {
    assert.strictEqual(isNamedCompany(n), false, `${n} must be refused`);
  }
});

test('isNamedCompany does not refuse real UAE company names', () => {
  // precision matters more than recall — a false positive costs a customer
  for (const n of ['Gulf Business Machines', 'Consolidated Shipping Services Group',
                   'Emirates Insurance Company', 'Al Shafar GRC', 'Dubai Health',
                   'National Bank of Umm Al Quwain', 'InsuranceMarket.ae',
                   'Wio Bank P.J.S.C.', 'Omega Insurance Brokers LLC',
                   'Zurich Life Insurance Middle East', 'GIG Gulf']) {
    assert.strictEqual(isNamedCompany(n), true, `${n} must be kept`);
  }
});

test('a high-scoring collective is dropped by mergeAssessments, but remembered', () => {
  const batch = [{ company: '', source: 'google-news', signal: 'three orgs breached' }];
  const { leads, assessed } = mergeAssessments(batch, [{
    index: 0, company: 'Three major UAE organisations (breach incident)',
    service: 'GRC / ISO 27001', icp_score: 9, why: 'breach', keep: true,
  }]);
  assert.deepStrictEqual(leads, [], 'must not reach the CRM');
  assert.strictEqual(assessed.length, 1, 'must be remembered so we stop re-billing it');
});

test('the prompt states both the naming rule and the scoring anchors', () => {
  const p = buildPrompt([{ company: 'X', source: 'y' }]);
  assert.match(p, /USE THE WHOLE RANGE/);
  assert.match(p, /Reserve 9 and 10 for evidence/);
  assert.match(p, /one specific, contactable organisation/);
  assert.match(p, /A breach story is only useful when the victim is named/);
});
