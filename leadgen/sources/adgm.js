'use strict';
/* adgm.js — the ADGM FSRA public register (free, no key).
 *
 * Abu Dhabi Global Market publishes every firm its Financial Services
 * Regulatory Authority has licensed — ~480 regulated financial companies
 * with the licence number and date, full address, and often a direct
 * corporate email and phone, all self-published on a government register.
 * This is the strongest candidate profile the pipeline has: UAE-based,
 * finance-sector, and carrying a STANDING compliance obligation (an FSRA
 * licence) — the exact trigger the ICP scores 8-9.
 *
 * Discovered by reading /js/FSRA/firm-listing.js on the register page: the
 * UI POSTs a filter object to /api/fsrac/firms/listing/filter and receives
 * paged JSON. The API ignores its own fspdate sort (always returns name
 * order — live-verified 2026-08-07), so freshness ordering is not available;
 * instead the register is small enough to sweep whole: pagesPerCycle pages
 * rotate per cycle, the full sweep completes in ~5 cycles, and re-sweeps
 * cost only the page fetches because dedupe drops known firms.
 *
 * Passive: a public government register, paced by lib/passive.js. Withdrawn
 * and suspended licences are skipped in code (the API's own status filter
 * takes opaque numeric IDs, and a wrong ID silently returns 0 rows).
 */
const cfg = require('../config');
const { request, UA } = require('../lib/http');
const { paced } = require('../lib/passive');
const { domainOf } = require('../lib/parse');

const API = 'https://www.adgm.com/api/fsrac/firms/listing/filter';

/** The exact payload firm-listing.js sends; only paging varies. */
function buildPayload(page, perPage = cfg.adgm.perPage) {
  return {
    sortBy: 'name#asc', searchQuery: '', companyType: '', assetClass: '',
    regulatedActivities: '', itemsPerPage: perPage, currentPage: page,
    firmStatus: '', recognitionStatus: '',
  };
}

/** 1-based pages for this cycle, wrapping over the register. Pure. */
function pagesForCycle(cycle, totalPages, perCycle = cfg.adgm.pagesPerCycle) {
  if (totalPages < 1) return [];
  const n = Math.min(perCycle, totalPages);
  const start = ((cycle * perCycle) % totalPages + totalPages) % totalPages;
  return Array.from({ length: n }, (_, i) => ((start + i) % totalPages) + 1);
}

const isActive = (firm) => firm && firm.companyStatus === 'Active';

/** Register row → candidate. Pure; exported for tests. */
function toCandidate(firm) {
  let website = firm.website || '';
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
  return {
    company: firm.company || '',
    website,
    domain: domainOf(website),
    email: (firm.email || '').toLowerCase(),
    phone: firm.phoneNumber || '',
    location: [firm.citi || 'Abu Dhabi', firm.country || 'United Arab Emirates']
      .filter(Boolean).join(', '),
    industry: 'Financial Services',
    source: 'adgm-fsra',
    signal: `ADGM FSRA-licensed financial firm` +
      (firm.permissionNumber ? ` (FSP ${firm.permissionNumber}` +
        (firm.fspDate ? `, since ${firm.fspDate}` : '') + ')' : ''),
  };
}

async function fetchPage(page) {
  const res = await paced(API,
    () => request(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(buildPayload(page)),
    }, { timeoutMs: 25000, retries: 1 }),
    { minIntervalMs: cfg.adgm.minIntervalMs });
  return res.json();
}

async function adgm(env, cycle = 0) {
  const out = [];
  // page 1 both yields candidates and tells us how big the register is
  const first = await fetchPage(1);
  const total = Number(first.totalItems) || 0;
  const totalPages = Math.max(1, Math.ceil(total / cfg.adgm.perPage));
  const pages = pagesForCycle(cycle, totalPages);
  const byPage = new Map([[1, first]]);
  for (const page of pages) {
    try {
      if (!byPage.has(page)) byPage.set(page, await fetchPage(page));
      for (const firm of (byPage.get(page).firmListingVM || [])) {
        if (!isActive(firm)) continue;
        const c = toCandidate(firm);
        if (c.company) out.push(c);
      }
    } catch (e) { console.warn(`  [adgm:page${page}] ${e.message}`); }
  }
  return out;
}

module.exports = { adgm, buildPayload, pagesForCycle, toCandidate, isActive };
