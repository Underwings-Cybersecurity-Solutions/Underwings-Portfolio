'use strict';
/* wikipedia.js — UAE companies from Wikipedia categories (free, no key).
 *
 * Complements wikidata.js rather than duplicating it: Wikidata only yields
 * entities that carry a P856 website statement, while plenty of UAE companies
 * have a Wikipedia article and no such statement. Those arrive name-only and
 * the website-finder resolves the domain downstream, exactly like the news
 * source.
 *
 * Passive: MediaWiki's public API. Categories rotate per cycle, and the API
 * is called with a real User-Agent (the MediaWiki etiquette policy asks for
 * one) through lib/passive.js's per-host pacing.
 */
const cfg = require('../config');
const { getJson } = require('../lib/http');
const { paced } = require('../lib/passive');

const API = 'https://en.wikipedia.org/w/api.php';
const UA = 'underwings-leadgen/1.0 (+https://underwings.org; lead research)';

// Articles whose titles are obviously not a prospect
const NOT_A_COMPANY =
  /^(list of|category:|template:|economy of|history of|timeline)/i;

/** Categories for this cycle. Pure; exported for tests. */
function categoriesForCycle(cycle, categories = cfg.wikipedia.categories,
                            perCycle = cfg.wikipedia.perCycle) {
  if (!categories.length) return [];
  const n = Math.min(perCycle, categories.length);
  const start = ((cycle % categories.length) + categories.length) % categories.length;
  return Array.from({ length: n }, (_, i) => categories[(start + i) % categories.length]);
}

/** Category member titles → candidates. Pure; exported for tests. */
function toCandidates(members, category) {
  return (members || [])
    .map((m) => String(m.title || ''))
    .filter((t) => t && !NOT_A_COMPANY.test(t))
    // "Musafir (company)" → "Musafir"
    .map((t) => t.replace(/\s*\((company|corporation|bank|airline|business|firm)\)\s*$/i, ''))
    .map((company) => ({
      company, website: '', domain: '', email: '', phone: '',
      location: 'United Arab Emirates', industry: '', source: 'wikipedia',
      signal: `Listed in Wikipedia's ${category.replace(/^Category:/, '').replace(/_/g, ' ')}`,
    }));
}

async function wikipedia(env, cycle = 0) {
  const out = [];
  const seen = new Set();
  for (const category of categoriesForCycle(cycle)) {
    try {
      const url = `${API}?action=query&list=categorymembers` +
        `&cmtitle=${encodeURIComponent(category)}&cmtype=page` +
        `&cmlimit=${cfg.wikipedia.perCategory}&format=json`;
      const j = await paced(url,
        () => getJson(url, { headers: { 'User-Agent': UA } }, { timeoutMs: 20000, retries: 1 }),
        { minIntervalMs: cfg.wikipedia.minIntervalMs });
      for (const c of toCandidates(j.query?.categorymembers, category)) {
        const key = c.company.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    } catch (e) { console.warn(`  [wikipedia:${category}] ${e.message}`); }
  }
  return out;
}

module.exports = { wikipedia, categoriesForCycle, toCandidates, NOT_A_COMPANY };
