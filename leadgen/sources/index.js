'use strict';
/*
 * sources/index.js — the 6 lead sources + free website-email enrichment.
 * Each source returns an array of candidate objects:
 *   { company, website, domain, email, phone, location, industry, source, signal? }
 * Sources that need an API key are skipped (with a log) when the key is absent.
 */
const cfg = require('../config');
const { getText, getJson, sleep } = require('../lib/http');
const P = require('../lib/parse');
const budget = require('../lib/budget');

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const WIKIDATA = 'https://query.wikidata.org/sparql';

/* ---------- 1. OpenStreetMap Overpass (free) ---------- */
async function overpass() {
  const out = [];
  const jobs = [
    ...cfg.overpass.officeCategories.map((c) => ['office', c]),
    ...cfg.overpass.amenityCategories.map((c) => ['amenity', c]),
  ];
  for (const [kind, cat] of jobs) {
    try {
      const ql = P.buildOverpassQL(cat, kind, cfg.overpass.iso, cfg.overpass.perCategoryLimit);
      const j = await getJson(OVERPASS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(ql),
      });
      out.push(...P.osmElementsToCandidates(j.elements, 'overpass'));
    } catch (e) { console.warn(`  [overpass:${cat}] ${e.message}`); }
    await sleep(2500); // be polite to the public Overpass endpoint (avoid 429)
  }
  return out;
}

/* ---------- 2. Wikidata SPARQL (free) ---------- */
async function wikidata() {
  const q = `SELECT ?cLabel ?website ?industryLabel WHERE {
    ?c wdt:P17 wd:Q878 .
    ?c wdt:P31/wdt:P279* wd:Q4830453 .
    OPTIONAL { ?c wdt:P856 ?website. }
    OPTIONAL { ?c wdt:P452 ?industry. }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } LIMIT ${cfg.wikidata.limit}`;
  try {
    const j = await getJson(`${WIKIDATA}?format=json&query=${encodeURIComponent(q)}`,
      { headers: { Accept: 'application/sparql-results+json' } });
    return (j.results?.bindings || []).map((b) => {
      const website = b.website?.value || '';
      return {
        company: b.cLabel?.value || '', website, domain: P.domainOf(website),
        email: '', phone: '', location: '',
        industry: b.industryLabel?.value || '', source: 'wikidata',
      };
    }).filter((c) => c.company && !/^Q\d+$/.test(c.company));
  } catch (e) { console.warn(`  [wikidata] ${e.message}`); return []; }
}

/* ---------- 3. Google News RSS (free, intent signals) ---------- */
async function googleNews() {
  const out = [];
  for (const query of cfg.googleNews.queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-AE&gl=AE&ceid=AE:en`;
      const xml = await getText(url);
      for (const it of P.parseRssItems(xml).slice(0, cfg.googleNews.perQueryLimit)) {
        out.push({
          company: '', website: '', domain: '', email: '', phone: '', location: '',
          industry: '', source: 'google-news',
          signal: `${it.title} — ${it.description}`.slice(0, 300),
        });
      }
    } catch (e) { console.warn(`  [google-news:${query}] ${e.message}`); }
  }
  return out;
}

/* ---------- 4. Google Places API (gated on key) ---------- */
async function places(env) {
  const key = env.GOOGLE_PLACES_API_KEY;
  if (!key) { console.log('  [places] skipped — no GOOGLE_PLACES_API_KEY'); return []; }
  const cap = cfg.places.monthlyCap;
  if (budget.remaining('google-places', cap) <= 0) {
    console.log(`  [places] skipped — monthly cap ${cap} reached`); return [];
  }
  const out = [];
  for (const textQuery of cfg.places.queries) {
    if (budget.remaining('google-places', cap) <= 0) {
      console.log(`  [places] monthly cap ${cap} reached — stopping`); break;
    }
    try {
      budget.spend('google-places', 1); // count before the (billable) request
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

/* ---------- 5/6. Firecrawl search + directory (gated on key) ---------- */
async function firecrawl(env) {
  const key = env.FIRECRAWL_API_KEY;
  if (!key) { console.log('  [firecrawl] skipped — no FIRECRAWL_API_KEY'); return []; }
  const out = [];
  const searches = [
    'UAE companies ISO 27001 certification needed',
    'Dubai fintech startups directory',
    'DMCC member companies technology',
  ];
  for (const query of searches) {
    try {
      const j = await getJson('https://api.firecrawl.dev/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, limit: 10 }),
      });
      for (const r of j.data || []) {
        out.push({
          company: r.title || '', website: r.url || '', domain: P.domainOf(r.url || ''),
          email: '', phone: '', location: '', industry: '', source: 'firecrawl',
          signal: (r.description || '').slice(0, 200),
        });
      }
    } catch (e) { console.warn(`  [firecrawl:${query}] ${e.message}`); }
  }
  return out;
}

/* ---------- free website-email enrichment ---------- */
async function enrichEmails(candidates) {
  for (const c of candidates) {
    if (c.email || !c.website) continue;
    try {
      const html = await getText(c.website, {}, { timeoutMs: 15000, retries: 1 })
        .catch(() => '');
      const emails = P.extractEmails(html);
      if (emails.length) c.email = emails.sort((a, b) => a.length - b.length)[0];
    } catch { /* best effort */ }
  }
  return candidates;
}

async function gatherAll(env) {
  const results = {};
  for (const [name, fn] of [
    ['overpass', () => overpass()], ['wikidata', () => wikidata()],
    ['google-news', () => googleNews()], ['places', () => places(env)],
    ['firecrawl', () => firecrawl(env)],
  ]) {
    const t = Date.now();
    const rows = await fn().catch((e) => { console.warn(`  [${name}] ${e.message}`); return []; });
    results[name] = rows;
    console.log(`  source ${name}: ${rows.length} candidates (${Date.now() - t}ms)`);
  }
  return results;
}

module.exports = { gatherAll, enrichEmails, overpass, wikidata, googleNews, places, firecrawl };
