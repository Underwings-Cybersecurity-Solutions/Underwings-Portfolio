'use strict';
/*
 * website-finder.js — find the official website for a company that arrived
 * without one (exhibitor lists often carry names only). One Firecrawl search
 * per company; the CALLER spends the 'firecrawl' budget before calling.
 */
const { getJson } = require('./http');
const { domainOf } = require('./parse');

const BAD = new Set(['linkedin', 'facebook', 'instagram', 'wikipedia',
  'youtube', 'twitter', 'x', 'pinterest', 'amazon', 'alibaba', 'aliexpress',
  'etsy', 'ebay', 'crunchbase', 'bloomberg', 'glassdoor', 'indeed', 'yelp',
  'tripadvisor', 'medium', 'reddit']);

/** True if any dot-separated label of the domain is a known non-company host. */
function isBadHost(domain) {
  return String(domain || '').toLowerCase().split('.').some((p) => BAD.has(p));
}

/** Rank Firecrawl results: token-matching real domains 11 > other real domains 1 > bad hosts out. */
function pickWebsite(results, company) {
  const tokens = String(company || '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  const score = (r) => {
    const d = domainOf(r.url || '');
    if (!d || isBadHost(d)) return -1;
    return tokens.some((t) => d.includes(t)) ? 11 : 1;
  };
  const best = (results || []).slice().sort((a, b) => score(b) - score(a))[0];
  return best && score(best) > 0 ? best.url : '';
}

async function findWebsite(company, key) {
  if (!key || !company) return '';
  try {
    const j = await getJson('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: `${company} official website`, limit: 3 }),
    });
    return pickWebsite(j.data || [], company);
  } catch (e) {
    console.warn(`  [website-finder:${company}] ${e.message}`);
    return '';
  }
}

module.exports = { findWebsite, pickWebsite, isBadHost };
