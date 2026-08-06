'use strict';
/* budget.test.js — the counter that stops us over-spending a plan shared with
 * another project. _setMemory is the seam that keeps these tests off the
 * network and out of the database. */
const test = require('node:test');
const assert = require('node:assert');
const budget = require('../lib/budget');

test('remaining is cap minus used and never goes negative', () => {
  budget._setMemory({ firecrawl: 90 });
  assert.strictEqual(budget.used('firecrawl'), 90);
  assert.strictEqual(budget.remaining('firecrawl', 300), 210);
  assert.strictEqual(budget.remaining('firecrawl', 50), 0);
});

test('an unknown source starts at zero', () => {
  budget._setMemory({});
  assert.strictEqual(budget.used('no-such-source'), 0);
  assert.strictEqual(budget.remaining('no-such-source', 10), 10);
});

test('spend is visible to the very next remaining() call', () => {
  // Sources check remaining() in a tight loop; an async-only counter would let
  // a whole cycle blow past the cap before the first write landed.
  budget._setMemory({ firecrawl: 0 }, true);   // offline: no durable write
  budget.spend('firecrawl', 3);
  assert.strictEqual(budget.used('firecrawl'), 3);
  assert.strictEqual(budget.remaining('firecrawl', 5), 2);
  budget.spend('firecrawl', 2);
  assert.strictEqual(budget.remaining('firecrawl', 5), 0);
});

test('flush resolves even when nothing was spent', async () => {
  budget._setMemory({}, true);
  await budget.flush();
});

test('every paid source maps to the env var that actually pays for it', () => {
  assert.deepStrictEqual(budget.KEY_ENV, {
    firecrawl: 'FIRECRAWL_API_KEY',
    'apollo-search': 'APOLLO_API_KEY',
    'apollo-match': 'APOLLO_API_KEY',
    'apollo-org': 'APOLLO_API_KEY',
    'google-places': 'GOOGLE_PLACES_API_KEY',
  });
});

test('apollo search and match share one key, so one key_ref', () => {
  process.env.APOLLO_API_KEY = 'test-apollo-key';
  assert.strictEqual(budget.keyRef('apollo-search'), budget.keyRef('apollo-match'));
  delete process.env.APOLLO_API_KEY;
});

test('key_ref is a hash — never the key itself', () => {
  process.env.FIRECRAWL_API_KEY = 'fc-super-secret-value';
  const ref = budget.keyRef('firecrawl');
  assert.strictEqual(ref.length, 16);
  assert.match(ref, /^[0-9a-f]{16}$/);
  assert.ok(!ref.includes('secret'));
  delete process.env.FIRECRAWL_API_KEY;
});

test('a different key gives a different counter', () => {
  process.env.FIRECRAWL_API_KEY = 'key-a';
  const a = budget.keyRef('firecrawl');
  process.env.FIRECRAWL_API_KEY = 'key-b';
  const b = budget.keyRef('firecrawl');
  assert.notStrictEqual(a, b);
  delete process.env.FIRECRAWL_API_KEY;
});

test('a missing key gets a stable placeholder rather than hashing empty', () => {
  delete process.env.GOOGLE_PLACES_API_KEY;
  assert.strictEqual(budget.keyRef('google-places'), 'nokey:google-places');
});

test('month is YYYY-MM', () => {
  assert.match(budget.month(), /^\d{4}-\d{2}$/);
});
