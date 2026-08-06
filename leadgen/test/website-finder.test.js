'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { pickWebsite, isBadHost } = require('../lib/website-finder');

test('isBadHost rejects socials/marketplaces/wikis at any subdomain depth', () => {
  assert.ok(isBadHost('linkedin.com'));
  assert.ok(isBadHost('it.linkedin.com'));
  assert.ok(isBadHost('en.wikipedia.org'));
  assert.ok(isBadHost('alibaba.com'));
  assert.ok(!isBadHost('bottegasrl.it'));
  assert.ok(!isBadHost('fedex.com')); // 'x' must match a whole label only
});

test('pickWebsite prefers a domain sharing a company-name token', () => {
  const results = [
    { url: 'https://www.linkedin.com/company/bottega-srl' },
    { url: 'https://leatherdirectory.example/bottega' },
    { url: 'https://www.bottegasrl.it/en' },
  ];
  assert.strictEqual(pickWebsite(results, 'Bottega SRL'), 'https://www.bottegasrl.it/en');
});

test('pickWebsite returns empty when only bad hosts', () => {
  const results = [{ url: 'https://facebook.com/x' }, { url: 'https://instagram.com/y' }];
  assert.strictEqual(pickWebsite(results, 'Acme Leather'), '');
  assert.strictEqual(pickWebsite([], 'Acme Leather'), '');
});
