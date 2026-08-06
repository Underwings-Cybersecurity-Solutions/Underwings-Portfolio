'use strict';
/* sources-free.test.js — the free sources are the backbone of this pipeline
 * (Hunter is dark and Firecrawl is capped), so their query construction is
 * worth pinning down. */
const test = require('node:test');
const assert = require('node:assert');
const { newsUrl } = require('../sources/news');
const { buildQueries, toCandidates } = require('../sources/wikidata');
const { buildOverpassQL, osmElementsToCandidates } = require('../lib/parse');
const cfg = require('../config');

test('Google News uses the UAE edition, not the US one', () => {
  const u = newsUrl('UAE company data breach');
  assert.match(u, /hl=en-AE/);
  assert.match(u, /gl=AE/);
  assert.match(u, /ceid=AE:en/);
  assert.match(u, /q=UAE%20company%20data%20breach/);
});

test('news queries cover breach, compliance and growth triggers', () => {
  const all = cfg.googleNews.queries.join(' ').toLowerCase();
  assert.match(all, /breach|ransomware|leak/);
  assert.match(all, /iso 27001|nesa|adhics|pdpl/);
  assert.match(all, /licence|expansion/);
});

test('wikidata SPARQL targets the UAE, not leather brands', () => {
  for (const [, q] of buildQueries(90)) {
    assert.match(q, /wd:Q878/, 'Q878 is the United Arab Emirates');
    assert.match(q, /wdt:P856/, 'a website is mandatory so there is a domain to work with');
    assert.ok(!q.includes('Q3661311'), 'fashion-house QID is Al Khaznah leftovers');
    assert.ok(!q.includes('Q786820'), 'automobile-manufacturer QID is Al Khaznah leftovers');
  }
});

test('wikidata splits into balanced, separately-issued branches', () => {
  const qs = buildQueries(90);
  assert.strictEqual(qs.length, 3);
  assert.deepStrictEqual(qs.map(([n]) => n),
    ['country-business', 'hq-in-uae', 'country-industry']);
  for (const [, q] of qs) assert.match(q, /LIMIT 30/, 'each branch gets its own share');
});

test('no wikidata branch uses a subclass property path', () => {
  // wdt:P31/wdt:P279* now times out on the public endpoint (65s, no result).
  for (const [name, q] of buildQueries(90)) {
    assert.ok(!/P279\s*\*/.test(q), `${name} reintroduced the subclass walk`);
  }
});

test('toCandidates maps bindings and drops unresolved Q-ids', () => {
  const out = toCandidates([
    { cLabel: { value: 'Gulf Bank PJSC' }, website: { value: 'https://gulfbank.ae/' }, industryLabel: { value: 'banking' } },
    { cLabel: { value: 'Q12345' }, website: { value: 'https://x.ae' } },
    { cLabel: { value: '' }, website: { value: 'https://y.ae' } },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].company, 'Gulf Bank PJSC');
  assert.strictEqual(out[0].domain, 'gulfbank.ae');
  assert.strictEqual(out[0].industry, 'banking');
  assert.strictEqual(out[0].location, 'United Arab Emirates');
  assert.strictEqual(out[0].source, 'wikidata');
});

test('overpass QL is bounded to the UAE and to a category', () => {
  const ql = buildOverpassQL('financial', 'office', 'AE', 60);
  assert.match(ql, /area\["ISO3166-1"="AE"\]/);
  assert.match(ql, /office"="financial/);
  assert.match(ql, /out .*60|60/);
});

test('osmElementsToCandidates pulls phones and emails OSM already has', () => {
  const [c] = osmElementsToCandidates([{
    tags: {
      name: 'Gulf Freight LLC', 'contact:website': 'https://gulffreight.ae',
      'contact:email': 'info@gulffreight.ae', phone: '+971 4 123 4567',
      'addr:city': 'Dubai',
    },
  }], 'overpass');
  assert.strictEqual(c.company, 'Gulf Freight LLC');
  assert.strictEqual(c.email, 'info@gulffreight.ae');
  assert.strictEqual(c.phone, '+971 4 123 4567');
  assert.strictEqual(c.source, 'overpass');
  assert.match(c.location, /Dubai/);
});

test('osmElementsToCandidates skips unnamed elements', () => {
  const out = osmElementsToCandidates([{ tags: { phone: '+9714' } }, { tags: {} }, {}], 'overpass');
  assert.deepStrictEqual(out, []);
});
