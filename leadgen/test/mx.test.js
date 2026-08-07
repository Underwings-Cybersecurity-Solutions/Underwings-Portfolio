'use strict';
/* mx.test.js — the deliverability floor. The resolver and db are injected:
 * no test may touch real DNS or the real store. The invariant under test is
 * the asymmetry: only a definitive negative ever writes anything. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mx = require('../lib/mx');

/** A resolver whose answers are scripted per domain. */
function fakeResolver(script) {
  const answer = (kind) => async (domain) => {
    const plan = (script[domain] || {})[kind];
    if (plan === undefined) { const e = new Error('ENODATA'); e.code = 'ENODATA'; throw e; }
    if (typeof plan === 'string') { const e = new Error(plan); e.code = plan; throw e; }
    return plan;
  };
  return { resolveMx: answer('mx'), resolve4: answer('a'), resolve6: answer('aaaa') };
}

test('verdicts: MX ok / null MX dead / NXDOMAIN dead / A-fallback ok / no route dead', async () => {
  const check = mx.createChecker(fakeResolver({
    'live.ae': { mx: [{ exchange: 'mail.live.ae', priority: 10 }] },
    'refuses.ae': { mx: [{ exchange: '.', priority: 0 }] },
    'gone.ae': { mx: 'ENOTFOUND' },
    'weblonly.ae': { a: ['1.2.3.4'] },
    'empty.ae': {},
  }));
  assert.strictEqual(await check('live.ae'), 'ok');
  assert.strictEqual(await check('refuses.ae'), 'dead');
  assert.strictEqual(await check('gone.ae'), 'dead');
  assert.strictEqual(await check('weblonly.ae'), 'ok');   // implicit MX via A
  assert.strictEqual(await check('empty.ae'), 'dead');
});

test('DNS trouble is unknown, never dead — on MX and on the A fallback', async () => {
  const check = mx.createChecker(fakeResolver({
    'flaky.ae': { mx: 'ETIMEOUT' },
    'halfflaky.ae': { a: 'ESERVFAIL' },   // no MX answer, A errors
  }));
  assert.strictEqual(await check('flaky.ae'), 'unknown');
  assert.strictEqual(await check('halfflaky.ae'), 'unknown');
});

test('pickDomains: distinct, cache-aware, recheck after expiry', () => {
  const emails = ['a@x.ae', 'b@x.ae', 'c@y.ae', 'd@z.ae', 'nodomain', null];
  const cache = {
    'x.ae': { v: 'ok', at: '2026-08-01' },     // fresh → skipped
    'y.ae': { v: 'ok', at: '2026-01-01' },     // stale → due again
  };
  const due = mx.pickDomains(emails, cache, { recheckDays: 60, today: '2026-08-07' });
  assert.deepStrictEqual(due, ['y.ae', 'z.ae']);
});

test('sweep marks contacts on dead domains only, and unknown is not cached', async () => {
  const updates = [];
  const contacts = [
    { email: 'a@dead.ae' }, { email: 'b@dead.ae' },
    { email: 'c@live.ae' }, { email: 'd@flaky.ae' },
  ];
  const db = {
    // answers both loadEmails (no email filter beyond not.is.null) and
    // invalidateDomain's pre-count (email=like.*@<domain>)
    select: async (table, q) => (q.email && q.email.startsWith('like.')
      ? contacts.filter((c) => c.email.endsWith(q.email.slice(q.email.indexOf('@'))))
      : contacts),
    // real PostgREST echoes [] here: the or-filter is re-applied to the NEW
    // row values, which no longer match — the count must not come from this
    update: async (table, match) => { updates.push(match.email); return []; },
  };
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mx-')), 'mx.json');
  const stats = await mx.sweep({
    db, cachePath, recheckDays: 60, today: '2026-08-07',
    resolver: fakeResolver({
      'live.ae': { mx: [{ exchange: 'mail.live.ae', priority: 10 }] },
      'dead.ae': { mx: 'ENOTFOUND' },
      'flaky.ae': { mx: 'ETIMEOUT' },
    }),
  });
  assert.deepStrictEqual(stats, { due: 3, checked: 3, dead: 1, unknown: 1, invalidated: 2 });
  assert.deepStrictEqual(updates, ['like.*@dead.ae']);
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.strictEqual(cache['dead.ae'].v, 'dead');
  assert.strictEqual(cache['live.ae'].v, 'ok');
  assert.ok(!('flaky.ae' in cache), 'unknown verdicts must be retried next pass');
});

test('sweep honours maxDomains and reports the full backlog as due', async () => {
  const db = {
    select: async () => [{ email: 'a@one.ae' }, { email: 'b@two.ae' }, { email: 'c@three.ae' }],
    update: async () => [],
  };
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mx-')), 'mx.json');
  const stats = await mx.sweep({
    db, cachePath, maxDomains: 1, recheckDays: 60, today: '2026-08-07',
    resolver: fakeResolver({ 'one.ae': { mx: [{ exchange: 'm.one.ae', priority: 1 }] } }),
  });
  assert.strictEqual(stats.due, 3);
  assert.strictEqual(stats.checked, 1);
});
