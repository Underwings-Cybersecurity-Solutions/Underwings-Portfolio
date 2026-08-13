'use strict';
/*
 * generate-vapt.js — one-shot UAE penetration-testing buyer list (kind='vapt').
 *
 * BLead-style bulk producer, NOT a loop: gather UAE software-operating
 * companies (Places matrix, ADGM register, GitHub orgs, optional CT logs),
 * score them against a VAPT-specific ICP, then walk a cost-ordered contact
 * reliability ladder — Places phone/website, LinkedIn URL discovery via web
 * search (never linkedin.com itself: auth-walled and ToS-restricted), website
 * scrape, inline MX verdicts — and upsert kind='vapt' rows.
 *
 * Apollo is deliberately absent: its UAE person-coverage is poor and this
 * track must not drain the shared org/search caps the daily loop lives on.
 *
 *   docker exec underwings-leadgen node generate-vapt.js --dry-run
 *   docker exec underwings-leadgen node generate-vapt.js [--limit 300] [--with-ctlogs]
 *
 * Re-runnable: global dedupe (store keys + seen.json, read-only) makes every
 * rerun additive-only. seen.json is NEVER written from here — the loop's
 * saveSeen would clobber it wholesale and vice versa.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const store = require('./lib/store-pg');
const budget = require('./lib/budget');
const mx = require('./lib/mx');
const { enrich } = require('./lib/enrich');
const { harvestContacts, bestEmail } = require('./lib/contacts');
const { getJson } = require('./lib/http');
const { domainOf, normCompany } = require('./lib/parse');
const { keyOf, keysOf, dedupeCandidates, interleave } = require('./run');
const { github } = require('./sources/github');
const { adgm } = require('./sources/adgm');
const { ctlogs } = require('./sources/ctlogs');

const DRY = process.argv.includes('--dry-run');
const WITH_CTLOGS = process.argv.includes('--with-ctlogs');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? Math.max(1, parseInt(process.argv[i + 1], 10) || 300) : 300;
})();

const UAE_RE = /\b(uae|u\.a\.e|united arab emirates|dubai|abu dhabi|sharjah|ajman|umm al|ras al|fujairah|al ain|musaffah|jebel ali|difc|dmcc|adgm)\b/i;

// ---- VAPT ICP (drives lib/enrich.js via the icp override) ----------------
const VAPT_ICP = {
  customerOnly: true,   // dev shops ARE the buyers here — no partner routing
  description:
    'UAE organisations that OPERATE CUSTOMER-FACING SOFTWARE and would buy ' +
    'penetration testing: fintech and payment companies (a CBUAE / DFSA / ' +
    'FSRA licence carries an annual pen-test expectation), e-commerce and ' +
    'online retail platforms, SaaS and software product companies, mobile ' +
    'app businesses, online booking and marketplace operators, healthcare ' +
    'providers with patient portals (ADHICS requires VAPT), and logistics ' +
    'platforms with customer tracking systems. Sweet spot 30-250 staff, ' +
    'acceptable to 500. Large enterprises (1000+ staff: major banks, ' +
    'airlines, telecoms, government bodies) are OUT — they buy through ' +
    'procurement from big firms; score them 3 or below. A company whose web ' +
    'presence is only a brochure site, with no login, no app, no payments, ' +
    'is NOT this buyer (that is the GRC track): score it 5 or below.',
  services: cfg.icp.services,
  sectors: cfg.icp.sectors,
  geo: 'United Arab Emirates',
  anchors:
    `    10 — UAE organisation with a LIVE trigger: a named breach or ` +
    `incident, or a tender/RFP with penetration-testing scope.\n` +
    `    8-9 — UAE-licensed fintech/payments firm, or a clear customer-facing ` +
    `app estate (product company, e-commerce platform, patient portal) PLUS ` +
    `a mandate (PCI DSS, ADHICS, regulator licence).\n` +
    `    6-7 — UAE and ships or operates software, but no visible mandate. ` +
    `This is the DEFAULT; do not inflate it.\n` +
    `    4-5 — UAE but brochure-site only; no software estate in evidence.\n` +
    `    1-3 — no UAE operations, or a pure cybersecurity competitor.\n`,
};

// ---- Places: candidate matrix + per-company lookup ------------------------
const VAPT_QUERIES = [
  'fintech company', 'payment gateway company', 'e-commerce company',
  'SaaS company', 'mobile app development company', 'software company',
];
const VAPT_REGIONS = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman',
                      'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain',
                      'DIFC Dubai', 'DMCC Dubai', 'ADGM Abu Dhabi',
                      'Dubai Internet City'];

const PLACES_MASK =
  'places.displayName,places.websiteUri,places.nationalPhoneNumber,places.formattedAddress';
// Leave the daily loop headroom on both shared monthly ledgers.
const PLACES_FLOOR = 500;
const FIRECRAWL_FLOOR = 20;

async function placesSearch(textQuery, key, maxResultCount = 5) {
  budget.spend('google-places', 1); // count before the billable request
  const j = await getJson('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': PLACES_MASK,
    },
    body: JSON.stringify({ textQuery, maxResultCount }),
  });
  return (j.places || []).map((p) => ({
    company: p.displayName?.text || '',
    website: p.websiteUri || '',
    domain: domainOf(p.websiteUri || ''),
    phone: p.nationalPhoneNumber || '',
    location: p.formattedAddress || '',
  }));
}

function placesHeadroom() {
  return budget.remaining('google-places', cfg.places.monthlyCap) > PLACES_FLOOR;
}

async function gatherPlaces(key) {
  const out = [];
  for (const q of VAPT_QUERIES) {
    for (const r of VAPT_REGIONS) {
      if (!placesHeadroom()) { console.log('  [places] cap floor reached — stopping'); return out; }
      try {
        for (const p of await placesSearch(`${q} in ${r}`, key, cfg.places.perRunResultLimit)) {
          out.push({ ...p, email: '', industry: '', source: 'google-places' });
        }
      } catch (e) { console.warn(`  [places:${q} in ${r}] ${e.message}`); }
    }
  }
  return out;
}

/** Company-name sanity for accepting a Places/LinkedIn hit: normalised
 * equality, or every ≥4-char token of one name appears in the other. */
function sameCompany(a, b) {
  const na = normCompany(a), nb = normCompany(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const tokens = (s) => s.split(/\s+/).filter((t) => t.length >= 4);
  const ta = tokens(na), tb = tokens(nb);
  if (!ta.length || !tb.length) return false;
  return ta.every((t) => nb.includes(t)) || tb.every((t) => na.includes(t));
}

/** Phone/website backfill for one lead. Accept only when the listing
 * verifiably IS this company: matching domain, or matching name. */
async function placesBackfill(lead, key) {
  if (!key || !placesHeadroom()) return;
  try {
    const hits = await placesSearch(`${lead.company} ${lead.emirate || 'UAE'}`, key, 3);
    const hit = hits.find((h) =>
      (lead.domain && h.domain && h.domain === lead.domain) ||
      sameCompany(h.company, lead.company));
    if (!hit) return;
    if (!lead.website && hit.website) { lead.website = hit.website; lead.domain = hit.domain; }
    if (!lead.phone && hit.phone && (!lead.domain || !hit.domain || hit.domain === lead.domain)) {
      lead.phone = hit.phone;
      lead.phoneFromPlaces = true;
    }
    if (!lead.location && hit.location) lead.location = hit.location;
  } catch (e) { console.warn(`  [places:${lead.company}] ${e.message}`); }
}

// ---- LinkedIn discovery (web search only — the bot never fetches linkedin.com)
const LI_COMPANY_RE = /linkedin\.com\/company\/[a-z0-9%._-]+/i;
const LI_SIZE_RE = /\b([\d,]+)\s*[-–]\s*([\d,]+)\s+employees\b|\b([\d,]+)\+\s+employees\b/i;

function sizeBandOfEmployees(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 30) return 'sub30';
  if (n < 250) return 'sme';
  if (n < 1000) return 'midmarket';
  return 'enterprise';
}

/** Parse "11-50 employees" / "10,001+ employees" from a SERP snippet. */
function employeeBandFromSnippet(text) {
  const m = LI_SIZE_RE.exec(String(text || ''));
  if (!m) return null;
  const num = (s) => parseInt(String(s).replace(/,/g, ''), 10);
  return m[3] != null ? sizeBandOfEmployees(num(m[3]))
                      : sizeBandOfEmployees(num(m[2])); // band by upper bound
}

async function linkedinLookup(lead, key) {
  if (!key) return;
  if (budget.remaining('firecrawl', cfg.firecrawl.monthlyCap) <= FIRECRAWL_FLOOR) return;
  budget.spend('firecrawl', 1);
  try {
    const j = await getJson('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: `site:linkedin.com/company "${lead.company}"`, limit: 1 }),
    });
    for (const r of j.data || []) {
      const m = LI_COMPANY_RE.exec(r.url || '');
      if (!m) continue;
      // the SERP title is "<Company> | LinkedIn" — verify before trusting
      if (!sameCompany(String(r.title || '').replace(/\s*\|\s*LinkedIn.*$/i, ''), lead.company)) continue;
      lead.companyLinkedin = 'https://www.' + m[0].replace(/^www\./i, '');
      const band = employeeBandFromSnippet(`${r.title || ''} ${r.description || ''}`);
      if (band && !lead.sizeBand) lead.sizeBand = band;
      return;
    }
  } catch (e) { console.warn(`  [linkedin:${lead.company}] ${e.message}`); }
}

// ---- UAE hard gate --------------------------------------------------------
function uaeEvidence(lead) {
  if (lead.emirate) return true;
  if (/\.ae$/i.test(lead.domain || '')) return true;
  if (UAE_RE.test(`${lead.location || ''} ${lead.country || ''}`)) return true;
  return false;
}

// ---- gather ---------------------------------------------------------------
async function gather(env) {
  const bySource = {};
  console.log('Gathering candidates…');

  if (env.GOOGLE_PLACES_API_KEY) {
    bySource['google-places'] = await gatherPlaces(env.GOOGLE_PLACES_API_KEY);
    console.log(`  [places] ${bySource['google-places'].length} candidates`);
  } else console.log('  [places] skipped — no GOOGLE_PLACES_API_KEY');

  // Partial sweeps via the sources' own cycle rotation. GitHub is capped at
  // 2 cycles (4 of 8 locations): the unauthenticated CORE api allows only
  // 60 req/hour per IP and every org needs a /users detail call — the first
  // full-sweep attempt 403'd more than half its orgs and starved the daily
  // loop's quota. Reruns rotate through the rest. ADGM's ~10 register pages
  // sweep in 5.
  const gh = [];
  for (let c = 0; c < 2; c++) gh.push(...await github(env, c));
  // GitHub AUP: org discovery only — published org emails stay out of a
  // bulk-mail list, so the address is dropped here and the company's own
  // website supplies contacts instead.
  bySource.github = gh.map((c) => ({ ...c, email: '' }));
  console.log(`  [github] ${bySource.github.length} candidates`);

  const ad = [];
  for (let c = 0; c < 5; c++) ad.push(...await adgm(env, c));
  bySource.adgm = ad;
  console.log(`  [adgm] ${bySource.adgm.length} candidates`);

  if (WITH_CTLOGS) {
    const ct = [];
    for (let c = 0; c < 2; c++) ct.push(...await ctlogs(env, c));
    bySource.ctlogs = ct;
    console.log(`  [ctlogs] ${bySource.ctlogs.length} candidates`);
  }
  return interleave(bySource);
}

// ---- reliability report ---------------------------------------------------
function report(leads) {
  const n = leads.length || 1;
  const pct = (k) => `${Math.round((k / n) * 100)}%`;
  const withEmail = leads.filter((l) => l.email || (l.emails || []).length).length;
  const withPhone = leads.filter((l) => l.phone || (l.phones || []).length).length;
  const withLi = leads.filter((l) => l.companyLinkedin).length;
  const withName = leads.filter((l) => l.contactName).length;
  const bySource = {};
  for (const l of leads) bySource[l.source] = (bySource[l.source] || 0) + 1;
  console.log('\n===== reliability report =====');
  console.log(`rows:            ${leads.length}`);
  console.log(`email (MX-live): ${withEmail} (${pct(withEmail)})`);
  console.log(`phone:           ${withPhone} (${pct(withPhone)})`);
  console.log(`linkedin url:    ${withLi} (${pct(withLi)})`);
  console.log(`named contact:   ${withName} (${pct(withName)})`);
  console.log(`by source:       ${JSON.stringify(bySource)}`);
  console.log('==============================\n');
}

// ---- main -----------------------------------------------------------------
async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1); }
  const env = process.env;

  await budget.sync();

  // Global dedupe surface: everything the store knows + everything the loop
  // has already assessed (read-only — see the header warning).
  const seen = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'state', 'seen.json'), 'utf8'));
    for (const k of j.keys || []) seen.add(k);
  } catch { /* first run or no file — fine */ }
  const db = await store.load();
  for (const rec of db.leads) { seen.add(rec.id); for (const k of keysOf(rec)) seen.add(k); }
  console.log(`Dedupe surface: ${seen.size} known keys`);

  const candidates = dedupeCandidates(await gather(env), seen).slice(0, LIMIT * 3);
  console.log(`Candidates after dedupe: ${candidates.length} (scoring cap ${LIMIT * 3})`);

  // Score against the VAPT ICP; keep >= 6 (deliberately below the loop's 7 —
  // a bulk list is worked by humans who can skim, and 6 is "ships software").
  const { leads: scored, failedBatches } = await enrich(apiKey, candidates, VAPT_ICP);
  if (failedBatches) console.warn(`  ${failedBatches} scoring batches failed (candidates retried on rerun)`);
  let leads = scored.filter((l) => l.icp_score >= 6);
  console.log(`Scored ${scored.length}, kept ${leads.length} at score >= 6`);

  // Stamp the campaign identity — enrich() only emits customer/partner.
  for (const l of leads) {
    l.kind = 'vapt';
    l.service = 'PTaaS / Pen Testing';
    l.source = 'vapt-gen';
  }

  // Best-first, and cut to the limit BEFORE the ladder — every ladder rung
  // spends a lookup, and spending it on rows the slice would discard is the
  // one waste this budget can't audit.
  leads.sort((a, b) => (b.icp_score || 0) - (a.icp_score || 0));
  leads = leads.slice(0, LIMIT);

  // Contact reliability ladder, cost-ordered.
  let i = 0;
  for (const l of leads) {
    i += 1;
    if (i % 25 === 0) console.log(`  ladder ${i}/${leads.length}…`);
    await placesBackfill(l, env.GOOGLE_PLACES_API_KEY);       // phone + website
    await linkedinLookup(l, env.LEADGEN_FIRECRAWL_API_KEY || env.FIRECRAWL_API_KEY);
    if (l.website) {
      try {
        const c = await harvestContacts(l.website, l.phone);
        // Same-domain only when the company HAS a domain: scraping minified
        // pages harvests third-party artifacts ("fonts.gst@ic.com" off a bank
        // site), and a cross-domain address on a domained company is far more
        // likely junk than a real outsourced mailbox. Domainless companies
        // keep whatever the scrape found — it's all they have.
        const own = (e) => !l.domain || String(e).split('@')[1] === l.domain;
        const emails = c.emails.filter(own);
        const best = own(c.best) ? c.best : bestEmail(emails, l.domain);
        if (best) { l.email = best; l.emailStatus = 'unverified'; }
        if (!l.phone && c.phones.length) l.phone = c.phones[0];
        l.emails = emails; l.phones = c.phones;
        if (!l.email && !emails.length && l.phone && l.phoneFromPlaces) l.contactSource = 'places';
      } catch (e) { console.warn(`  [scrape:${l.company}] ${e.message}`); }
    } else if (l.phone && l.phoneFromPlaces) l.contactSource = 'places';
    if (l.sizeBand === 'enterprise') l.disqualified = 'enterprise (LinkedIn size)';
  }

  // UAE hard gate — dropped, not stored: geography misses are noise.
  const before = leads.length;
  leads = leads.filter(uaeEvidence);
  for (const l of leads) if (!l.country) l.country = 'United Arab Emirates';
  console.log(`UAE gate: kept ${leads.length}/${before}`);

  // Inline MX pass: emails on dead domains never enter the DB. One checker,
  // domains deduped, 'unknown' kept (resolver trouble is not a dead company).
  const domains = new Set();
  for (const l of leads) for (const e of [l.email, ...(l.emails || [])]) {
    const d = String(e || '').split('@')[1];
    if (d) domains.add(d.toLowerCase());
  }
  const verdictOf = mx.createChecker();
  const verdicts = new Map();
  await mx.mapLimit([...domains], 10, async (d) => verdicts.set(d, await verdictOf(d)));
  const alive = (e) => {
    const d = String(e || '').split('@')[1];
    return !d || verdicts.get(d.toLowerCase()) !== 'dead';
  };
  let killed = 0;
  for (const l of leads) {
    const had = (l.emails || []).length + (l.email ? 1 : 0);
    l.emails = (l.emails || []).filter(alive);
    if (l.email && !alive(l.email)) l.email = bestEmail(l.emails, l.domain) || '';
    killed += had - ((l.emails || []).length + (l.email ? 1 : 0));
  }
  console.log(`MX gate: ${domains.size} domains checked, ${killed} dead addresses dropped`);

  // Reachability floor: a row with no email AND no phone cannot be worked —
  // in a hand-built list it is noise wearing a score.
  const unreachable = leads.filter((l) => !l.email && !(l.emails || []).length && !l.phone).length;
  leads = leads.filter((l) => l.email || (l.emails || []).length || l.phone);
  console.log(`Reachability floor: ${unreachable} contactless rows dropped`);

  report(leads);

  if (DRY) {
    console.log('--dry-run: nothing written. Sample of 10:');
    for (const l of leads.slice(0, 10)) {
      console.log(`  ${l.icp_score}  ${l.company}  ${l.domain || '-'}  ` +
        `${l.email || '-'}  ${l.phone || '-'}  ${l.companyLinkedin || '-'}`);
    }
  } else {
    let inserted = 0;
    for (let b = 0; b < leads.length; b += 500) {
      inserted += await store.upsertLeads(leads.slice(b, b + 500));
      console.log(`  upserted ${Math.min(b + 500, leads.length)}/${leads.length} (${inserted} new)`);
    }
    console.log(`Done: ${inserted} new vapt prospects stored.`);
  }

  await budget.flush();
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = {   // pure helpers, exported for tests
  VAPT_ICP, VAPT_QUERIES, VAPT_REGIONS, sameCompany, uaeEvidence,
  employeeBandFromSnippet, sizeBandOfEmployees,
};
