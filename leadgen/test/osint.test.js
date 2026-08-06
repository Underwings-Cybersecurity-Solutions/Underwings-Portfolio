'use strict';
/* osint.test.js — the passive OSINT tier: pacing governor + the pure halves
 * of the three new archive sources. No network: every network function here
 * is exercised through its pure extractor. */
const test = require('node:test');
const assert = require('node:assert');
const passive = require('../lib/passive');
const CT = require('../sources/ctlogs');
const W = require('../sources/wikipedia');
const G = require('../sources/github');
const cfg = require('../config');

// ---------- pacing ----------
test('paced serialises same-host calls and holds the floor interval', async () => {
  passive._reset();
  const starts = [];
  const call = () => passive.paced('https://crt.sh/x',
    () => { starts.push(Date.now()); return Promise.resolve(1); },
    { minIntervalMs: 60, jitterMs: 0 });
  const t0 = Date.now();
  await Promise.all([call(), call(), call()]);
  assert.strictEqual(starts.length, 3);
  // three calls, two gaps — the last must not start before 2 intervals
  assert.ok(starts[2] - t0 >= 110, `third call started after ${starts[2] - t0}ms`);
  assert.ok(starts[1] < starts[2], 'calls must not overlap');
});

test('a failing call still holds the slot open for the next one', async () => {
  passive._reset();
  await assert.rejects(passive.paced('https://x.test/a',
    () => Promise.reject(new Error('boom')), { minIntervalMs: 1, jitterMs: 0 }));
  // the chain must survive the rejection, not poison every later caller
  const v = await passive.paced('https://x.test/b', () => Promise.resolve('ok'),
    { minIntervalMs: 1, jitterMs: 0 });
  assert.strictEqual(v, 'ok');
});

test('different hosts are paced independently', async () => {
  passive._reset();
  const t0 = Date.now();
  await Promise.all([
    passive.paced('https://a.test/', () => Promise.resolve(1), { minIntervalMs: 80, jitterMs: 0 }),
    passive.paced('https://b.test/', () => Promise.resolve(1), { minIntervalMs: 80, jitterMs: 0 }),
  ]);
  assert.ok(Date.now() - t0 < 70, 'a slow host must not delay an unrelated one');
});

// ---------- certificate transparency ----------
test('registrableOf reduces a SAN to its .ae registrable domain', () => {
  assert.strictEqual(CT.registrableOf('shop.acme.co.ae', 'co.ae'), 'acme.co.ae');
  assert.strictEqual(CT.registrableOf('*.acme.co.ae', 'co.ae'), 'acme.co.ae');
  assert.strictEqual(CT.registrableOf('ACME.CO.AE', 'co.ae'), 'acme.co.ae');
  assert.strictEqual(CT.registrableOf('acme.co.uk', 'co.ae'), '', 'wrong suffix');
  assert.strictEqual(CT.registrableOf('co.ae', 'co.ae'), '', 'the suffix itself is not a company');
  assert.strictEqual(CT.registrableOf('', 'co.ae'), '');
});

test('CT noise hosts never become prospects', () => {
  for (const h of ['autodiscover.acme.co.ae', 'webmail.acme.co.ae', 'cpanel.acme.co.ae',
                   'mx1.acme.co.ae', 'vpn.acme.co.ae', 'staging.acme.co.ae']) {
    assert.strictEqual(CT.registrableOf(h, 'co.ae'), '', `${h} should be filtered`);
  }
});

test('toCandidates dedupes multi-SAN certs into one candidate per domain', () => {
  const rows = [
    { name_value: 'acme.co.ae\nwww.acme.co.ae\nshop.acme.co.ae' },
    { name_value: 'acme.co.ae' },
    { name_value: 'other.co.ae' },
    { name_value: '' },
    {},
  ];
  const c = CT.toCandidates(rows, 'co.ae');
  assert.strictEqual(c.length, 2);
  assert.deepStrictEqual(c.map((x) => x.domain).sort(), ['acme.co.ae', 'other.co.ae']);
  // domain-only candidates must carry a signal, or run.js drops them for
  // having no company name
  assert.ok(c[0].signal.includes('acme.co.ae'));
  assert.strictEqual(c[0].website, 'https://acme.co.ae');
  assert.strictEqual(c[0].location, 'United Arab Emirates');
});

test('CT patterns are UAE-only second levels and rotate without repeating', () => {
  for (const p of cfg.ctlogs.patterns) assert.match(p, /^%\.[a-z]+\.ae$/);
  const seen = new Set();
  for (let i = 0; i < cfg.ctlogs.patterns.length; i++) {
    for (const p of CT.patternsForCycle(i)) seen.add(p);
  }
  assert.strictEqual(seen.size, cfg.ctlogs.patterns.length, 'every pattern must come up');
  assert.deepStrictEqual(CT.patternsForCycle(-1).length, cfg.ctlogs.perCycle,
    'negative cycle must not throw or return empty');
});

// ---------- wikipedia ----------
test('wikipedia keeps companies and drops meta-articles', () => {
  const c = W.toCandidates([
    { title: 'Musafir (company)' }, { title: 'Emirates NBD' },
    { title: 'List of companies of the United Arab Emirates' },
    { title: 'Economy of Dubai' }, { title: 'Template:UAE' },
  ], 'Category:Companies_of_the_United_Arab_Emirates');
  assert.deepStrictEqual(c.map((x) => x.company), ['Musafir', 'Emirates NBD']);
  assert.match(c[0].signal, /Companies of the United Arab Emirates/);
  assert.strictEqual(c[0].source, 'wikipedia');
});

test('every wikipedia category is UAE-scoped and rotation covers them all', () => {
  for (const cat of cfg.wikipedia.categories) {
    assert.match(cat, /^Category:/);
    assert.match(cat, /United_Arab_Emirates|Dubai|Abu_Dhabi/,
      `${cat} is not UAE-scoped`);
  }
  const seen = new Set();
  for (let i = 0; i < cfg.wikipedia.categories.length; i++) {
    for (const c of W.categoriesForCycle(i)) seen.add(c);
  }
  assert.strictEqual(seen.size, cfg.wikipedia.categories.length);
});

// ---------- github ----------
test('github org profile maps onto a candidate, website only when a real URL', () => {
  const c = G.toCandidate({
    login: 'acme-ae', name: 'Acme LLC', blog: 'https://acme.ae',
    location: 'Dubai', bio: 'We build logistics software', email: 'dev@acme.ae',
  }, 'Dubai');
  assert.strictEqual(c.company, 'Acme LLC');
  assert.strictEqual(c.domain, 'acme.ae');
  assert.strictEqual(c.email, 'dev@acme.ae');
  assert.strictEqual(c.source, 'github');
  assert.match(c.signal, /logistics software/);

  const bare = G.toCandidate({ login: 'x', blog: 'acme.ae' }, 'Sharjah');
  assert.strictEqual(bare.website, '', 'a non-URL blog must not become a website');
  assert.strictEqual(bare.company, 'x', 'login is the fallback name');
  assert.strictEqual(bare.location, 'Sharjah');
});

test('github locations are UAE places and rotate', () => {
  const UAE = /Dubai|Abu Dhabi|Sharjah|Ajman|Ras Al Khaimah|Fujairah|Umm Al Quwain|United Arab Emirates|UAE/;
  for (const l of cfg.github.locations) assert.match(l, UAE, `${l} is not in the UAE`);
  assert.strictEqual(G.locationsForCycle(0).length, cfg.github.perCycle);
  assert.notDeepStrictEqual(G.locationsForCycle(0), G.locationsForCycle(1));
});

test('the passive tier is paced slowly enough to stay a polite reader', () => {
  // These are free public archives; bursts are what gets an IP banned.
  assert.ok(cfg.github.minIntervalMs >= 6000, 'unauthenticated GitHub search allows 10/min');
  assert.ok(cfg.ctlogs.minIntervalMs >= 3000);
  assert.ok(cfg.wikipedia.minIntervalMs >= 1000);
  assert.ok(cfg.ctlogs.perCycle <= 2, 'each crt.sh query takes ~60s');
});

test('a crt.sh 404 is treated as transient, so the pattern is retried', () => {
  // crt.sh answers 404/502 within a second for a URL that returns 200 on the
  // next try; believing the first 404 silently disabled the whole source
  const T = /HTTP (404|429|50\d) /;
  assert.ok(T.test('HTTP 404 for https://crt.sh/?q=%.co.ae :: <html>'));
  assert.ok(T.test('HTTP 502 for https://crt.sh/ :: x'));
  assert.ok(T.test('HTTP 429 for https://crt.sh/ :: x'));
  assert.ok(!T.test('fetch failed'), 'a transport error is not a status retry');
  assert.ok(cfg.ctlogs.attempts >= 1);
  assert.ok(cfg.ctlogs.retryIntervalMs >= cfg.ctlogs.minIntervalMs,
    'a retry must wait longer than the normal pace, not hammer');
});
