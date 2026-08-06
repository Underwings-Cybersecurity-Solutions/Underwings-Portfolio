'use strict';
/* wikidata.js — UAE-registered organisations (free SPARQL).
 *
 * Three branches, issued as THREE SEPARATE REQUESTS rather than one UNION:
 *   A. country (P17) = UAE (Q878) + direct instance-of business enterprise
 *   B. headquarters (P159) in a place whose country is the UAE — catches
 *      entities that carry an HQ city but no P17
 *   C. country = UAE + has an industry (P452) — catches organisations typed
 *      as something other than business enterprise
 * All three require a website (P856) so there is a domain to work with.
 *
 * Why separate requests (live-verified 2026-08-02):
 *  - `wdt:P31/wdt:P279* wd:Q4830453`, which the old pipeline used, now TIMES
 *    OUT on the public endpoint (65s, no result). The subclass tree has grown
 *    past what WDQS will walk. Every branch here uses direct properties only.
 *  - Even with direct properties, the three branches UNIONed into one query
 *    took 48-65s and intermittently timed out, while each branch on its own
 *    returns in ~3s. Splitting them also means a slow branch costs us that
 *    branch, not the whole source.
 * If you add a branch, time it before committing it.
 */
const cfg = require('../config');
const { getJson } = require('../lib/http');
const { domainOf } = require('../lib/parse');

const ENDPOINT = 'https://query.wikidata.org/sparql';

/** One SPARQL query per branch. `perBranch` rows each. */
function buildQueries(limit = cfg.wikidata.limit) {
  const n = Math.max(1, Math.ceil(limit / 3));
  const tail = 'SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }';
  return [
    ['country-business', `SELECT DISTINCT ?cLabel ?website ?industryLabel WHERE {
  ?c wdt:P17 wd:Q878 ; wdt:P31 wd:Q4830453 ; wdt:P856 ?website .
  OPTIONAL { ?c wdt:P452 ?industry . }
  ${tail}
} LIMIT ${n}`],
    ['hq-in-uae', `SELECT DISTINCT ?cLabel ?website ?hqLabel WHERE {
  ?c wdt:P159 ?hq ; wdt:P856 ?website .
  ?hq wdt:P17 wd:Q878 .
  ${tail}
} LIMIT ${n}`],
    ['country-industry', `SELECT DISTINCT ?cLabel ?website ?industryLabel WHERE {
  ?c wdt:P17 wd:Q878 ; wdt:P452 ?industry ; wdt:P856 ?website .
  ${tail}
} LIMIT ${n}`],
  ];
}

function toCandidates(bindings) {
  return (bindings || []).map((b) => {
    const website = b.website?.value || '';
    return {
      company: b.cLabel?.value || '', website, domain: domainOf(website),
      email: '', phone: '',
      location: b.hqLabel?.value || 'United Arab Emirates',
      industry: b.industryLabel?.value || '', source: 'wikidata',
    };
  }).filter((c) => c.company && !/^Q\d+$/.test(c.company));
}

async function wikidata() {
  const out = [];
  const seen = new Set();
  for (const [name, query] of buildQueries()) {
    try {
      const j = await getJson(`${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`,
        { headers: { Accept: 'application/sparql-results+json' } },
        { timeoutMs: 45000, retries: 0 });   // WDQS is slow and flaky; don't retry into a second timeout
      for (const c of toCandidates(j.results?.bindings)) {
        const key = c.domain || c.company.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    } catch (e) { console.warn(`  [wikidata:${name}] ${e.message}`); }
  }
  return out;
}

module.exports = { wikidata, buildQueries, toCandidates };
