'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../lib/dates');

test('formatDates: with and without verified', () => {
  assert.strictEqual(D.formatDates({ added: '2026-07-24', verified: '' }), 'added 2026-07-24');
  assert.strictEqual(D.formatDates({ added: '2026-07-24', verified: '2026-08-20' }),
    'added 2026-07-24 · verified 2026-08-20');
});

test('parseDates: round-trips and tolerates junk', () => {
  assert.deepStrictEqual(D.parseDates('added 2026-07-24 · verified 2026-08-20'),
    { added: '2026-07-24', verified: '2026-08-20' });
  assert.deepStrictEqual(D.parseDates('added 2026-07-24'), { added: '2026-07-24', verified: '' });
  assert.deepStrictEqual(D.parseDates(''), { added: '', verified: '' });
  assert.deepStrictEqual(D.parseDates(undefined), { added: '', verified: '' });
});

test('daysSince: computes day gaps; empty/bad → Infinity', () => {
  assert.strictEqual(D.daysSince('2026-07-01', '2026-07-24'), 23);
  assert.strictEqual(D.daysSince('2026-07-24', '2026-07-24'), 0);
  assert.strictEqual(D.daysSince('', '2026-07-24'), Infinity);
  assert.strictEqual(D.daysSince('garbage', '2026-07-24'), Infinity);
});
