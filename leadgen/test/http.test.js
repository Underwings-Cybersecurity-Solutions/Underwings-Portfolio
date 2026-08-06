'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { getJson } = require('../lib/http');

test('getJson forwards per-call retry/timeout options to request', async () => {
  // connection-refused fails fast; with retries:0 there must be NO backoff
  // retries (default is 2 retries with 1.5s+3s backoff ≈ 4.5s+).
  const t0 = Date.now();
  await assert.rejects(
    getJson('http://127.0.0.1:9/none', {}, { timeoutMs: 1000, retries: 0 }));
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms — options not forwarded`);
});
