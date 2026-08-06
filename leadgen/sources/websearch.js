'use strict';
/* websearch.js — Firecrawl web search over a segment × region query matrix,
 * rotated a few queries per cycle. Budget-capped ('firecrawl'). */
const cfg = require('../config');
const { getJson } = require('../lib/http');
const { domainOf } = require('../lib/parse');
const budget = require('../lib/budget');

/** Full deterministic matrix: every template × region. */
function buildQueryMatrix(ws = cfg.websearch) {
  const out = [];
  for (const t of ws.templates) for (const r of ws.regions) out.push(t.replace('{region}', r));
  return out;
}

/** The perCycle-sized slice for cycle N (wraps; deterministic). */
function queriesForCycle(cycle, ws = cfg.websearch) {
  const all = buildQueryMatrix(ws);
  const start = (cycle * ws.perCycle) % all.length;
  const out = [];
  for (let i = 0; i < ws.perCycle; i++) out.push(all[(start + i) % all.length]);
  return out;
}

async function webSearch(env, cycle) {
  const key = env.FIRECRAWL_API_KEY;
  if (!key) { console.log('  [websearch] skipped — no FIRECRAWL_API_KEY'); return []; }
  const out = [];
  for (const query of queriesForCycle(cycle)) {
    if (budget.remaining('firecrawl', cfg.firecrawl.monthlyCap) <= 0) {
      console.log('  [websearch] firecrawl monthly cap reached — stopping'); break;
    }
    // search bills per result (est.) — reconcile vs Firecrawl dashboard after first live cycle
    budget.spend('firecrawl', cfg.websearch.perQueryLimit);
    try {
      const j = await getJson('https://api.firecrawl.dev/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, limit: cfg.websearch.perQueryLimit }),
      });
      for (const r of j.data || []) {
        out.push({
          company: r.title || '', website: r.url || '', domain: domainOf(r.url || ''),
          email: '', phone: '', location: '', industry: '', source: 'websearch',
          signal: (r.description || '').slice(0, 200),
        });
      }
    } catch (e) { console.warn(`  [websearch:${query}] ${e.message}`); }
  }
  return out;
}

module.exports = { webSearch, buildQueryMatrix, queriesForCycle };
