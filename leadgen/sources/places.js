'use strict';
/* places.js — Google Places API (New), gated on GOOGLE_PLACES_API_KEY.
 *
 * The best source of phone numbers, and it overlaps Overpass heavily, so it
 * runs last and fills gaps. The X-Goog-FieldMask is deliberately minimal:
 * displayName + websiteUri + nationalPhoneNumber + formattedAddress keeps the
 * call on the cheap SKU. Rotated sector x region so a 6h cadence doesn't
 * re-request the same handful of queries forever. */
const cfg = require('../config');
const { getJson } = require('../lib/http');
const P = require('../lib/parse');
const budget = require('../lib/budget');

/** Full deterministic matrix: every template x sector x region. */
function buildQueryMatrix(p = cfg.places) {
  const out = [];
  for (const t of p.templates) {
    for (const s of p.sectors) {
      for (const r of p.regions) out.push(t.replace('{sector}', s).replace('{region}', r));
    }
  }
  return out;
}

/** The perCycle-sized slice for cycle N (wraps; deterministic). */
function queriesForCycle(cycle, p = cfg.places) {
  const all = buildQueryMatrix(p);
  const n = Math.min(p.perCycle || all.length, all.length);
  const start = ((cycle * n) % all.length + all.length) % all.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(all[(start + i) % all.length]);
  return out;
}

async function places(env, cycle = 0) {
  const key = env.GOOGLE_PLACES_API_KEY;
  if (!key) { console.log('  [places] skipped — no GOOGLE_PLACES_API_KEY'); return []; }
  const cap = cfg.places.monthlyCap;
  if (budget.remaining('google-places', cap) <= 0) {
    console.log(`  [places] skipped — monthly cap ${cap} reached`); return [];
  }
  const out = [];
  for (const textQuery of queriesForCycle(cycle)) {
    if (budget.remaining('google-places', cap) <= 0) {
      console.log(`  [places] monthly cap ${cap} reached — stopping`); break;
    }
    try {
      budget.spend('google-places', 1); // count before the billable request
      const j = await getJson('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.displayName,places.websiteUri,places.nationalPhoneNumber,places.formattedAddress',
        },
        body: JSON.stringify({ textQuery, maxResultCount: cfg.places.perRunResultLimit }),
      });
      for (const p of j.places || []) {
        out.push({
          company: p.displayName?.text || '', website: p.websiteUri || '',
          domain: P.domainOf(p.websiteUri || ''), email: '',
          phone: p.nationalPhoneNumber || '', location: p.formattedAddress || '',
          industry: '', source: 'google-places',
        });
      }
    } catch (e) { console.warn(`  [places:${textQuery}] ${e.message}`); }
  }
  return out;
}

module.exports = { places, buildQueryMatrix, queriesForCycle };
