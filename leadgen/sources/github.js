'use strict';
/* github.js — UAE organisations that publish code (free, no key).
 *
 * A company with a GitHub org has developers, repositories and — usually —
 * cloud infrastructure, which is exactly the profile that buys pen testing
 * and cloud security reviews. The org profile carries the website, so these
 * candidates arrive with a domain already attached (unlike the news source).
 *
 * Passive: GitHub's own public API, never the company's infrastructure.
 * Unauthenticated search is 10 requests/minute, so locations rotate per cycle
 * and lib/passive.js keeps a wide gap between calls. GitHub asks for a real
 * User-Agent; sending one is the polite protocol, not a disguise.
 *
 * SCOPE LIMIT — do not "improve" this into a people harvester. GitHub's
 * Acceptable Use Policies forbid using information from GitHub (including
 * commit author addresses and member profiles) to send unsolicited bulk
 * commercial email. Reading an ORGANISATION's public profile to learn that a
 * UAE company exists and where its website is stays inside that line;
 * scraping `/users/:org/events` or `/repos/.../commits` for individual
 * developers' addresses to cold-mail them does not. The org's own published
 * contact address (`org.email`) is the only address this source takes.
 */
const cfg = require('../config');
const { getJson } = require('../lib/http');
const { paced } = require('../lib/passive');
const { domainOf } = require('../lib/parse');

const API = 'https://api.github.com';
const UA = 'underwings-leadgen (+https://underwings.org)';

function headers() {
  return { Accept: 'application/vnd.github+json', 'User-Agent': UA };
}

/** Locations for this cycle. Pure; exported for tests. */
function locationsForCycle(cycle, locations = cfg.github.locations,
                           perCycle = cfg.github.perCycle) {
  if (!locations.length) return [];
  const n = Math.min(perCycle, locations.length);
  const start = ((cycle % locations.length) + locations.length) % locations.length;
  return Array.from({ length: n }, (_, i) => locations[(start + i) % locations.length]);
}

/** Org profile → candidate. Pure; exported for tests. */
function toCandidate(org, location) {
  const website = org.blog && /^https?:\/\//i.test(org.blog) ? org.blog : '';
  return {
    company: org.name || org.login || '',
    website, domain: domainOf(website),
    email: org.email || '', phone: '',
    location: org.location || location,
    industry: '', source: 'github',
    signal: org.bio ? String(org.bio).slice(0, 200) : '',
  };
}

async function github(env, cycle = 0) {
  const out = [];
  const seen = new Set();
  for (const location of locationsForCycle(cycle)) {
    try {
      const q = `location:"${location}" type:org`;
      const url = `${API}/search/users?q=${encodeURIComponent(q)}&per_page=${cfg.github.perLocation}`;
      const list = await paced(url,
        () => getJson(url, { headers: headers() }, { timeoutMs: 20000, retries: 1 }),
        { minIntervalMs: cfg.github.minIntervalMs });

      for (const item of (list.items || [])) {
        if (!item.login || seen.has(item.login)) continue;
        seen.add(item.login);
        // the search result is a stub — the profile carries website + bio
        const durl = `${API}/users/${encodeURIComponent(item.login)}`;
        try {
          const org = await paced(durl,
            () => getJson(durl, { headers: headers() }, { timeoutMs: 20000, retries: 1 }),
            { minIntervalMs: cfg.github.minIntervalMs });
          const c = toCandidate(org, location);
          if (c.company) out.push(c);
        } catch (e) { console.warn(`  [github:${item.login}] ${e.message}`); }
      }
    } catch (e) { console.warn(`  [github:${location}] ${e.message}`); }
  }
  return out;
}

module.exports = { github, locationsForCycle, toCandidate };
