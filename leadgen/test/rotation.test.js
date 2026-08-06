'use strict';
/* rotation.test.js — every paid or rate-limited source rotates its query
 * matrix by cycle number. If rotation breaks we either re-request the same
 * handful of queries forever (and discover nothing new) or hammer a public
 * endpoint into 429s, which is exactly what the old pipeline did. */
const test = require('node:test');
const assert = require('node:assert');
const O = require('../sources/overpass');
const P = require('../sources/places');
const W = require('../sources/websearch');
const cfg = require('../config');

test('overpass rotates a fixed-size slice of its category jobs', () => {
  const all = O.allJobs();
  assert.strictEqual(all.length,
    cfg.overpass.officeCategories.length + cfg.overpass.amenityCategories.length);
  const c0 = O.jobsForCycle(0);
  const c1 = O.jobsForCycle(1);
  assert.strictEqual(c0.length, cfg.overpass.categoriesPerCycle);
  assert.notDeepStrictEqual(c0, c1, 'consecutive cycles must not repeat');
});

test('overpass rotation is deterministic and wraps', () => {
  assert.deepStrictEqual(O.jobsForCycle(0), O.jobsForCycle(0));
  const all = O.allJobs();
  const n = cfg.overpass.categoriesPerCycle;
  const period = all.length;                       // start index cycles mod length
  assert.deepStrictEqual(O.jobsForCycle(0), O.jobsForCycle(period * n));
  assert.strictEqual(O.jobsForCycle(9999).length, n);
});

test('overpass eventually covers every category', () => {
  const seen = new Set();
  for (let c = 0; c < 200; c++) for (const [k, v] of O.jobsForCycle(c)) seen.add(`${k}:${v}`);
  assert.strictEqual(seen.size, O.allJobs().length, 'some category is never scanned');
});

test('places builds a template x sector x region matrix', () => {
  const m = P.buildQueryMatrix();
  assert.strictEqual(m.length,
    cfg.places.templates.length * cfg.places.sectors.length * cfg.places.regions.length);
  assert.ok(m.every((q) => !q.includes('{')), 'every placeholder must be substituted');
  assert.ok(m.includes('healthcare companies in Dubai'));
});

test('places rotation is deterministic, sized and wraps', () => {
  assert.strictEqual(P.queriesForCycle(0).length, cfg.places.perCycle);
  assert.deepStrictEqual(P.queriesForCycle(3), P.queriesForCycle(3));
  assert.notDeepStrictEqual(P.queriesForCycle(0), P.queriesForCycle(1));
  assert.strictEqual(P.queriesForCycle(100000).length, cfg.places.perCycle);
});

test('websearch matrix is fully substituted and rotates', () => {
  const m = W.buildQueryMatrix();
  assert.strictEqual(m.length, cfg.websearch.templates.length * cfg.websearch.regions.length);
  assert.ok(m.every((q) => !q.includes('{region}')));
  assert.strictEqual(W.queriesForCycle(0).length, cfg.websearch.perCycle);
  assert.notDeepStrictEqual(W.queriesForCycle(0), W.queriesForCycle(1));
});

test('a negative or garbage cycle number never yields an undefined query', () => {
  for (const c of [-1, -7, 0]) {
    assert.ok(O.jobsForCycle(c).every(Boolean), `overpass cycle ${c}`);
    assert.ok(P.queriesForCycle(c).every(Boolean), `places cycle ${c}`);
  }
});
