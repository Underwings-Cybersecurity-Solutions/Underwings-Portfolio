'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  VAPT_ICP, VAPT_QUERIES, VAPT_REGIONS, sameCompany, uaeEvidence,
  employeeBandFromSnippet, sizeBandOfEmployees,
} = require('../generate-vapt');
const { buildPrompt, mergeAssessments } = require('../lib/enrich');
const { toProspectRow, KINDS } = require('../lib/store-pg');
const abv = require('../analyse-blead-vapt');

// ---- VAPT ICP drives the prompt -------------------------------------------

test('VAPT icp override swaps the buyer definition and the anchors', () => {
  const p = buildPrompt([{ company: 'PayFast', source: 'google-places' }], VAPT_ICP);
  assert.match(p, /OPERATE CUSTOMER-FACING SOFTWARE/);
  assert.match(p, /penetration-testing scope/);           // VAPT anchors, not the GRC ones
  assert.doesNotMatch(p, /clear standing obligation \(ISO 27001/);
});

test('customerOnly suppresses the partner track entirely', () => {
  const p = buildPrompt([{ company: 'X', source: 'y' }], VAPT_ICP);
  assert.match(p, /ALWAYS set kind='customer'/);
  assert.doesNotMatch(p, /TIE-BREAK: many firms could both buy AND refer/);
});

test('default prompt is unchanged by the override machinery', () => {
  const p = buildPrompt([{ company: 'Acme Clinic', source: 'overpass' }]);
  assert.match(p, /TIE-BREAK: many firms could both buy AND refer/);
  assert.match(p, /clear standing obligation \(ISO 27001/);
});

test('customerOnly merge refuses a stray partner kind from the model', () => {
  const batch = [{ company: 'Acme IT' }];
  const { leads } = mergeAssessments(batch, [
    { index: 0, keep: true, kind: 'partner', icp_score: 7, service: '', company: 'Acme IT' },
  ], VAPT_ICP);
  assert.strictEqual(leads[0].kind, 'customer');
});

// ---- store accepts the new kind -------------------------------------------

test('kind vapt survives toProspectRow; junk still coerces to customer', () => {
  assert.ok(KINDS.includes('vapt'));
  assert.strictEqual(toProspectRow({ company: 'X', kind: 'vapt' }).kind, 'vapt');
  assert.strictEqual(toProspectRow({ company: 'X', kind: 'nonsense' }).kind, 'customer');
});

// ---- LinkedIn SERP parsing -------------------------------------------------

test('employee band parses ranges, commas and the 10,001+ form', () => {
  assert.strictEqual(employeeBandFromSnippet('Acme | LinkedIn · 11-50 employees'), 'sme');
  assert.strictEqual(employeeBandFromSnippet('Acme · 51–200 employees · Dubai'), 'sme');
  assert.strictEqual(employeeBandFromSnippet('Big Corp · 1,001-5,000 employees'), 'enterprise');
  assert.strictEqual(employeeBandFromSnippet('Mega · 10,001+ employees'), 'enterprise');
  assert.strictEqual(employeeBandFromSnippet('Tiny · 2-10 employees'), 'sub30');
  assert.strictEqual(employeeBandFromSnippet('no size here'), null);
});

test('size bands match the crm size_band CHECK vocabulary', () => {
  assert.deepStrictEqual(
    [29, 30, 249, 250, 999, 1000].map(sizeBandOfEmployees),
    ['sub30', 'sme', 'sme', 'midmarket', 'midmarket', 'enterprise']);
});

// ---- company matching guard ------------------------------------------------

test('sameCompany accepts legal-suffix variants, rejects strangers', () => {
  assert.ok(sameCompany('PayTabs LLC', 'PayTabs'));
  assert.ok(sameCompany('Telr Payment Gateway', 'Telr Payment Gateway FZ-LLC'));
  assert.ok(!sameCompany('PayTabs', 'Network International'));
  assert.ok(!sameCompany('', 'PayTabs'));
});

// ---- UAE hard gate ---------------------------------------------------------

test('uaeEvidence: emirate, .ae domain, or a UAE location string', () => {
  assert.ok(uaeEvidence({ emirate: 'Dubai' }));
  assert.ok(uaeEvidence({ domain: 'shop.co.ae' }));
  assert.ok(uaeEvidence({ location: 'DIFC, Dubai' }));
  assert.ok(uaeEvidence({ country: 'United Arab Emirates' }));
  assert.ok(!uaeEvidence({ location: 'Riyadh, Saudi Arabia', domain: 'x.com' }));
});

// ---- matrix sanity ---------------------------------------------------------

test('the Places matrix is software-buyer queries across the emirates', () => {
  assert.ok(VAPT_QUERIES.some((q) => /fintech/.test(q)));
  assert.ok(VAPT_QUERIES.some((q) => /e-commerce|SaaS/i.test(q)));
  assert.ok(VAPT_REGIONS.includes('Dubai') && VAPT_REGIONS.includes('Abu Dhabi'));
});

// ---- blead analysis pieces -------------------------------------------------

test('global vendor domains are excluded deterministically, subdomains included', () => {
  assert.ok(abv.isVendorDomain('lusha.com'));
  assert.ok(abv.isVendorDomain('ocs.oraclecloud.com'));   // the tier-1 leak that forced this
  assert.ok(abv.isVendorDomain('zohocdn.com'));
  assert.ok(abv.isVendorDomain('cognizant.com'));
  assert.ok(!abv.isVendorDomain('pais.ae'));
  assert.ok(!abv.isVendorDomain('focussoftnet.com'));
  assert.ok(!abv.isVendorDomain(''));
});

test('classifier prompt is conservative and carries the rows', () => {
  const p = abv.classifyPrompt([
    { company_name: 'Bitweb Technologies', domain: 'bitweb.ae', industry: '' },
  ]);
  assert.match(p, /BE CONSERVATIVE/);
  assert.match(p, /When in doubt: false/);
  assert.match(p, /\[0\] Bitweb Technologies \| bitweb\.ae \| -/);
  const req = abv.TOOL.input_schema.properties.items.items.required;
  for (const k of ['index', 'vapt_relevant', 'reason']) assert.ok(req.includes(k));
});

test('classifier prompt excludes vendors, enterprises and non-UAE companies', () => {
  const p = abv.classifyPrompt([{ company_name: 'X', domain: '', industry: '' }]);
  assert.match(p, /Global technology vendors/);
  assert.match(p, /procurement-gated, out of profile/);
  assert.match(p, /without UAE operations/);
});

test('foreign ccTLDs are skipped before either tier; UAE startup TLDs stay', () => {
  assert.ok(abv.FOREIGN_TLD.test('omantel.net.om'));
  assert.ok(abv.FOREIGN_TLD.test('csrforum.pk'));
  assert.ok(abv.FOREIGN_TLD.test('tye4eewmail.co.uk'));
  assert.ok(abv.FOREIGN_TLD.test('acme.in'));
  assert.ok(abv.FOREIGN_TLD.test('x.com.sa'));
  assert.ok(!abv.FOREIGN_TLD.test('bitweb.ae'));
  assert.ok(!abv.FOREIGN_TLD.test('paytabs.com'));
  assert.ok(!abv.FOREIGN_TLD.test('omniconn.ai'));
  assert.ok(!abv.FOREIGN_TLD.test('confluencetech.me'));
  assert.ok(!abv.FOREIGN_TLD.test('fairlygreen.io'));
});

test('inList quotes dedupe keys for PostgREST in.()', () => {
  assert.strictEqual(abv.inList(['d:x.ae', 'c:acme llc']),
    'in.("d:x.ae","c:acme llc")');
});
