'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { gatherAll, DEFAULT_SOURCES } = require('../sources');

test('gatherAll isolates a throwing source and keeps the rest', async () => {
  const registry = [
    ['good', async () => [{ company: 'Acme', source: 'good' }]],
    ['boom', async () => { throw new Error('network down'); }],
    ['sync-boom', () => { throw new Error('immediate'); }],
  ];
  const r = await gatherAll({}, 0, registry);
  assert.deepStrictEqual(r.good, [{ company: 'Acme', source: 'good' }]);
  assert.deepStrictEqual(r.boom, []);
  assert.deepStrictEqual(r['sync-boom'], []);
});

test('DEFAULT_SOURCES wires every source, free ones first and crt.sh last', () => {
  assert.deepStrictEqual(DEFAULT_SOURCES.map(([n]) => n),
    ['overpass', 'wikidata', 'wikipedia', 'github', 'google-news', 'websearch',
     'exhibitors', 'google-places', 'ctlogs']);
  // ctlogs spends ~60s per pattern; it must never delay a source that yields
  // named companies
  assert.strictEqual(DEFAULT_SOURCES[DEFAULT_SOURCES.length - 1][0], 'ctlogs');
});
