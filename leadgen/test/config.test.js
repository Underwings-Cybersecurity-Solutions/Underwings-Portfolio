'use strict';
/* config.test.js — the cheapest, highest-value test in the suite: it catches a
 * config typo before it costs API money or writes junk the CRM can't display. */
const test = require('node:test');
const assert = require('node:assert');
const cfg = require('../config');

test('ICP targets UAE cyber-compliance buyers', () => {
  assert.match(cfg.icp.description, /UAE-based/);
  assert.match(cfg.icp.description, /ISO 27001 \/ NESA \/ ADHICS \/ PDPL/);
  assert.strictEqual(cfg.icp.geo, 'United Arab Emirates');
});

test('service lines match what the website actually sells', () => {
  assert.deepStrictEqual(cfg.icp.services, [
    'GRC / ISO 27001', 'PTaaS / Pen Testing', 'Cloud Security',
    'Network & Infrastructure', 'Training & Awareness',
  ]);
});

test('sectors are non-empty and unique', () => {
  assert.ok(cfg.icp.sectors.length >= 8);
  assert.strictEqual(new Set(cfg.icp.sectors).size, cfg.icp.sectors.length);
});

test('salesStatuses matches the crm_prospects status CHECK in migration 011', () => {
  // Keep in lockstep: a status here that Postgres rejects fails the whole write.
  assert.deepStrictEqual(cfg.salesStatuses, [
    'new', 'enriched', 'contacted', 'replied', 'qualified',
    'disqualified', 'promoted', 'suppressed',
  ]);
});

test('paid caps: firecrawl split, apollo positive, hunter gone', () => {
  // Firecrawl is shared with Al Khaznah, which keeps its own counter.
  assert.ok(cfg.firecrawl.monthlyCap <= 500,
    'firecrawl cap must leave headroom for the Al Khaznah project');
  // Apollo (own key, 2026-08-02) replaced Hunter — both counters must be
  // enabled, and any stale hunter block would mean a bad merge.
  assert.ok(cfg.apollo.searchCap > 0, 'apollo search must be enabled');
  assert.ok(cfg.apollo.matchCap > 0, 'apollo email reveal must be enabled');
  assert.ok(cfg.apollo.orgCap > 0, 'apollo org enrichment must be enabled — the only endpoint the Free plan allows');
  assert.ok(cfg.apollo.matchCap <= cfg.apollo.searchCap,
    'reveals cannot outnumber the searches that precede them');
  assert.strictEqual(cfg.hunter, undefined, 'hunter config should be removed');
});

test('run cadence and thresholds are sane', () => {
  assert.ok(cfg.scoreThreshold >= 1 && cfg.scoreThreshold <= 10);
  assert.ok(cfg.maxCandidatesPerRun > 0 && cfg.maxCandidatesPerRun <= 200);
  assert.ok(cfg.intervalMinutes >= 60);
  assert.ok(cfg.runNowPollSeconds >= 15);
  assert.ok(cfg.claudeBatchSize > 0);
  assert.match(cfg.claudeModel, /^claude-/);
});

test('every enabled rotation source has a non-empty matrix', () => {
  assert.ok(cfg.websearch.templates.length && cfg.websearch.regions.length);
  assert.ok(cfg.places.templates.length && cfg.places.sectors.length && cfg.places.regions.length);
  assert.ok(cfg.overpass.officeCategories.length && cfg.overpass.amenityCategories.length);
  assert.ok(cfg.googleNews.queries.length);
});

test('any exhibitor show that IS configured has an absolute URL', () => {
  // The list is empty by design (see config.js — no UAE show directory could be
  // verified on 2026-08-02). This guards whatever gets added next: an entry
  // without a real https URL burns Firecrawl credits for nothing.
  for (const s of cfg.exhibitors.shows) {
    assert.ok(s.name && /^https:\/\//.test(s.url), `bad show entry: ${JSON.stringify(s)}`);
  }
});
