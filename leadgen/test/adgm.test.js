'use strict';
/* adgm.test.js — the pure halves of the ADGM FSRA register source: payload
 * shape, page rotation, status filter, candidate mapping. The network
 * function is never called here (public API, no key to gate on). The firm
 * fixture is a real row from /api/fsrac/firms/listing/filter, 2026-08-07. */
const test = require('node:test');
const assert = require('node:assert');
const A = require('../sources/adgm');

const FIRM = {
  pageUrl: '/public-registers/fsra/firms/financial-firms/36-south-me-limited-250085',
  companyStatus: 'Active',
  permissionNumber: '250085',
  firmID: 'FF-0936',
  company: '36 SOUTH ME LIMITED',
  citi: 'Abu Dhabi',
  location: 'Maryah Island',
  country: 'United Arab Emirates',
  address: 'United Arab Emirates, Abu Dhabi, Maryah Island, Al Sarab Tower',
  fspDate: '2025-12-19',
  legalStatus: 'ADGM Company (a private company limited by shares)',
  email: 'Jamie.Evans@36south.com',
  website: null,
  phoneNumber: '+44 02032053000',
};

test('buildPayload matches the shape firm-listing.js sends, only paging varies', () => {
  const p = A.buildPayload(3, 50);
  assert.deepStrictEqual(p, {
    sortBy: 'name#asc', searchQuery: '', companyType: '', assetClass: '',
    regulatedActivities: '', itemsPerPage: 50, currentPage: 3,
    firmStatus: '', recognitionStatus: '',
  });
});

test('pagesForCycle sweeps the whole register and wraps', () => {
  // 10 pages, 2 per cycle: five cycles cover 1..10, cycle 5 wraps to the start
  assert.deepStrictEqual(A.pagesForCycle(0, 10, 2), [1, 2]);
  assert.deepStrictEqual(A.pagesForCycle(4, 10, 2), [9, 10]);
  assert.deepStrictEqual(A.pagesForCycle(5, 10, 2), [1, 2]);
  // a shrinking register never yields out-of-range pages
  assert.deepStrictEqual(A.pagesForCycle(7, 3, 2), [3, 1]);
  assert.deepStrictEqual(A.pagesForCycle(0, 1, 2), [1]);
  assert.deepStrictEqual(A.pagesForCycle(9, 0, 2), []);
});

test('only Active licences pass the status filter', () => {
  assert.ok(A.isActive({ companyStatus: 'Active' }));
  assert.ok(!A.isActive({ companyStatus: 'Withdrawn' }));
  assert.ok(!A.isActive({ companyStatus: 'Suspended' }));
  assert.ok(!A.isActive(null));
});

test('toCandidate maps a register row onto the candidate shape', () => {
  const c = A.toCandidate(FIRM);
  assert.strictEqual(c.company, '36 SOUTH ME LIMITED');
  assert.strictEqual(c.email, 'jamie.evans@36south.com');   // lower-cased
  assert.strictEqual(c.phone, '+44 02032053000');
  assert.strictEqual(c.location, 'Abu Dhabi, United Arab Emirates');
  assert.strictEqual(c.industry, 'Financial Services');
  assert.strictEqual(c.source, 'adgm-fsra');
  assert.strictEqual(c.website, '');                        // null stays empty
  assert.match(c.signal, /FSRA-licensed/);
  assert.match(c.signal, /FSP 250085/);
  assert.match(c.signal, /2025-12-19/);
});

test('toCandidate normalises a schemeless website into a real URL + domain', () => {
  const c = A.toCandidate({ ...FIRM, website: 'www.36south.com' });
  assert.strictEqual(c.website, 'https://www.36south.com');
  assert.strictEqual(c.domain, '36south.com');
});
