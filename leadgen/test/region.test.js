'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { regionOf, bucketOf } = require('../lib/region');

test('regionOf maps countries to regions', () => {
  assert.strictEqual(regionOf('Italy'), 'Europe');
  assert.strictEqual(regionOf('united arab emirates'), 'MENA');
  assert.strictEqual(regionOf('Turkey'), 'MENA');
  assert.strictEqual(regionOf('India'), 'Asia');
  assert.strictEqual(regionOf('USA'), 'Americas');
  assert.strictEqual(regionOf('Ethiopia'), 'Africa');
  assert.strictEqual(regionOf('Australia'), 'Oceania');
});

test('regionOf strips the low-confidence "?" and handles unknown/empty', () => {
  assert.strictEqual(regionOf('Italy?'), 'Europe');
  assert.strictEqual(regionOf('Atlantis'), '');
  assert.strictEqual(regionOf(''), '');
  assert.strictEqual(regionOf(undefined), '');
});

test('regionOf trims before stripping "?" so a trailing space does not hide it', () => {
  // 'Italy? ' — the '?' isn't trailing until the trailing space is trimmed first.
  assert.strictEqual(regionOf('Italy? '), 'Europe');
});

test('regionOf handles long-form country name aliases', () => {
  assert.strictEqual(regionOf("People's Republic of China"), 'Asia');
  assert.strictEqual(regionOf('Republic of Korea'), 'Asia');
  assert.strictEqual(regionOf('Kingdom of Saudi Arabia'), 'MENA');
});

test('bucketOf maps UAE, GCC and everything else', () => {
  assert.strictEqual(bucketOf('UAE'), 'uae');
  assert.strictEqual(bucketOf('United Arab Emirates'), 'uae');
  assert.strictEqual(bucketOf('Saudi Arabia'), 'gcc');
  assert.strictEqual(bucketOf('Kingdom of Saudi Arabia'), 'gcc');
  assert.strictEqual(bucketOf('Qatar'), 'gcc');
  assert.strictEqual(bucketOf('Kuwait'), 'gcc');
  assert.strictEqual(bucketOf('Bahrain'), 'gcc');
  assert.strictEqual(bucketOf('Oman'), 'gcc');
  assert.strictEqual(bucketOf('Italy'), 'global');
  assert.strictEqual(bucketOf(''), 'global');
  assert.strictEqual(bucketOf(undefined), 'global');
});

test('bucketOf is case-insensitive and strips the low-confidence "?"', () => {
  assert.strictEqual(bucketOf('saudi arabia?'), 'gcc');
  assert.strictEqual(bucketOf('Saudi Arabia?'), 'gcc');
  assert.strictEqual(bucketOf('uae?'), 'uae');
});
