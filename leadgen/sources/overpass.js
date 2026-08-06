'use strict';
/* overpass.js — OpenStreetMap Overpass (free, no API key).
 *
 * The single best free source for this ICP: it is geography-bounded (ISO AE)
 * and sector-tagged, and OSM rows often already carry a phone number and
 * sometimes an email. Categories rotate per cycle — hitting all 16 jobs every
 * 12h reliably earned 429s and 504s from the public endpoint. */
const cfg = require('../config');
const { getJson, sleep } = require('../lib/http');
const P = require('../lib/parse');

const OVERPASS = 'https://overpass-api.de/api/interpreter';

/** All [kind, category] jobs, in a stable order. */
function allJobs(o = cfg.overpass) {
  return [
    ...o.officeCategories.map((c) => ['office', c]),
    ...o.amenityCategories.map((c) => ['amenity', c]),
  ];
}

/** The categoriesPerCycle-sized slice for cycle N (wraps; deterministic). */
function jobsForCycle(cycle, o = cfg.overpass) {
  const all = allJobs(o);
  const n = Math.min(o.categoriesPerCycle || all.length, all.length);
  const start = ((cycle * n) % all.length + all.length) % all.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(all[(start + i) % all.length]);
  return out;
}

async function overpass(env, cycle = 0) {
  const out = [];
  for (const [kind, cat] of jobsForCycle(cycle)) {
    try {
      const ql = P.buildOverpassQL(cat, kind, cfg.overpass.iso, cfg.overpass.perCategoryLimit);
      const j = await getJson(OVERPASS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(ql),
      });
      out.push(...P.osmElementsToCandidates(j.elements, 'overpass'));
    } catch (e) { console.warn(`  [overpass:${cat}] ${e.message}`); }
    await sleep(2500); // be polite to the public endpoint
  }
  return out;
}

module.exports = { overpass, allJobs, jobsForCycle };
