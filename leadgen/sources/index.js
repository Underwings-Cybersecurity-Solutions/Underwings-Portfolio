'use strict';
/* sources/index.js — gather candidates from all sources; one failing source
 * never kills a cycle.
 *
 * Every source returns the same candidate shape:
 *   { company, website, domain, email, phone, location, industry, source, signal? }
 *
 * Order matters: the free, highest-precision UAE sources run first, so if a
 * paid source is capped or dark the cycle still has material to score.
 */
const cfg = require('../config');
const { overpass } = require('./overpass');
const { adgm } = require('./adgm');
const { wikidata } = require('./wikidata');
const { wikipedia } = require('./wikipedia');
const { github } = require('./github');
const { ctlogs } = require('./ctlogs');
const { googleNews } = require('./news');
const { webSearch } = require('./websearch');
const { exhibitors } = require('./exhibitors');
const { places } = require('./places');

const DEFAULT_SOURCES = [
  ['overpass', (env, cycle) => overpass(env, cycle)],
  // government register with direct contacts — free and high precision, so
  // it runs before the noisier discovery sources
  ['adgm', (env, cycle) => adgm(env, cycle)],
  ['wikidata', () => wikidata()],
  ['wikipedia', (env, cycle) => wikipedia(env, cycle)],
  ['github', (env, cycle) => github(env, cycle)],
  ['google-news', () => googleNews()],
  ['websearch', (env, cycle) => webSearch(env, cycle)],
  ['exhibitors', (env, cycle) => exhibitors(env, cycle)],
  ['google-places', (env, cycle) => places(env, cycle)],
  // last: crt.sh takes ~60s per pattern, and a stall here must not delay the
  // sources that produce named companies
  ['ctlogs', (env, cycle) => ctlogs(env, cycle)],
];

async function gatherAll(env, cycle, registry = DEFAULT_SOURCES) {
  const disabled = new Set(cfg.disabledSources || []);
  const results = {};
  for (const [name, fn] of registry) {
    if (disabled.has(name)) {
      console.log(`  source ${name}: disabled (config.disabledSources)`);
      results[name] = [];
      continue;
    }
    const t = Date.now();
    const rows = await Promise.resolve()
      .then(() => fn(env, cycle))
      .catch((e) => { console.warn(`  [${name}] ${e.message}`); return []; });
    results[name] = rows || [];
    console.log(`  source ${name}: ${results[name].length} candidates (${Date.now() - t}ms)`);
  }
  return results;
}

module.exports = { gatherAll, DEFAULT_SOURCES };
