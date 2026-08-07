'use strict';
/*
 * config.js — single place to tune the Underwings lead generator.
 * Edit ICP / sources / caps here; no code changes needed.
 *
 * Underwings is a UAE cybersecurity & compliance consultancy. The buyers we
 * want are UAE organisations carrying a regulatory obligation (ISO 27001,
 * NESA/UAE IA, ADHICS, PDPL) or an obvious security gap, in the SME-to-
 * mid-market band where there is unlikely to be an in-house security team.
 */
module.exports = {
  // ---- Who we're looking for (Claude scores against this) ----
  icp: {
    description:
      'UAE-based mid-range organisations — the sweet spot is 30-250 staff, ' +
      'acceptable up to 500 — in regulated or data-sensitive sectors: ' +
      'banking, finance, insurance, healthcare and clinics, legal, real ' +
      'estate, logistics and freight, education, retail/e-commerce, ' +
      'technology and IT services, and government-adjacent entities. The ' +
      'ideal buyer carries a security or compliance obligation, has NO ' +
      'mature in-house security team, and has a single reachable decision ' +
      'maker (owner, GM, IT manager) who can sign off in weeks — Underwings ' +
      'is a five-person consultancy and cannot fight enterprise procurement. ' +
      'Large enterprises (1000+ staff: major banks, airlines, telecoms, ' +
      'government bodies, famous groups) are OUT of profile — score them 3 ' +
      'or below no matter how strong their compliance obligation is; they ' +
      'buy from big firms through procurement, not from startups. Companies ' +
      'under 30 staff are in profile ONLY with an explicit compliance ' +
      'trigger (a tender demanding ISO 27001, ADHICS/NESA/PDPL applicability, ' +
      'a breach in the news); otherwise score them 4-5. ' +
      'Strong signals: an ISO 27001 / NESA / ADHICS / PDPL obligation or ' +
      'deadline, a recent breach or outage, a tender or RFP mentioning ' +
      'information security, rapid headcount or branch growth, a new UAE ' +
      'entity or licence, a cloud or ERP migration, or handling of payment, ' +
      'health or personal data at scale.',
    // The Underwings service lines Claude must map each lead to:
    services: ['GRC / ISO 27001', 'PTaaS / Pen Testing', 'Cloud Security',
               'Network & Infrastructure', 'Training & Awareness'],
    sectors: ['Banking & Finance', 'Insurance', 'Healthcare', 'Legal',
              'Real Estate', 'Logistics', 'Education', 'Retail & E-commerce',
              'Technology & IT', 'Government-adjacent', 'Hospitality',
              'Manufacturing'],
    geo: 'United Arab Emirates',
  },

  // ---- Discovery sources ----

  // Sources listed here are skipped entirely by gatherAll. Wikidata and the
  // Wikipedia company categories were retired 2026-08-06: a company notable
  // enough for an encyclopedia entry is almost always 1000+ staff — between
  // them they produced 60 prospects including most of the enterprise band,
  // which the ICP now excludes. Re-enable by removing from this list.
  disabledSources: ['wikidata', 'wikipedia'],

  // 1. OpenStreetMap Overpass (free, no key). Geography-bounded and
  // sector-tagged, which is exactly our ICP shape. Categories rotate per
  // cycle so we don't re-hit all 16 jobs every 12h (and trip 429s).
  overpass: {
    iso: 'AE',
    officeCategories: ['company', 'it', 'financial', 'insurance', 'lawyer',
                       'accountant', 'consulting', 'logistics', 'government',
                       'educational_institution', 'estate_agent'],
    amenityCategories: ['bank', 'hospital', 'clinic', 'pharmacy', 'college'],
    perCategoryLimit: 60,
    categoriesPerCycle: 6,  // 6 of 16 per cycle — all 16 at once earned 429s
  },

  // 2. Wikidata SPARQL (free) — UAE-headquartered businesses.
  wikidata: { limit: 300 },

  // 2b. Passive OSINT tier (free, no keys). All three read PUBLIC ARCHIVES —
  // certificate transparency logs, Wikipedia, GitHub's public API — never a
  // prospect's own infrastructure, and lib/passive.js paces every request.
  // Everything here is .ae / UAE-scoped by construction.

  // Certificate Transparency: the .ae second levels are UAE-only by registry
  // policy. One pattern per cycle — each query takes ~60s (see ctlogs.js).
  ctlogs: {
    patterns: ['%.co.ae', '%.net.ae', '%.org.ae', '%.gov.ae', '%.sch.ae'],
    perCycle: 1,
    perPattern: 120,      // registrable domains kept per pattern
    timeoutMs: 90000,
    minIntervalMs: 5000,
    attempts: 2,          // crt.sh 404s/502s transiently — see ctlogs.js
    retryIntervalMs: 20000,
  },

  // Wikipedia categories — UAE companies that have an article but no Wikidata
  // website statement, so wikidata.js can never see them.
  wikipedia: {
    categories: [
      'Category:Companies_of_the_United_Arab_Emirates',
      'Category:Companies_based_in_Dubai',
      'Category:Companies_based_in_Abu_Dhabi',
      'Category:Banks_of_the_United_Arab_Emirates',
      'Category:Insurance_companies_of_the_United_Arab_Emirates',
      'Category:Health_care_companies_of_the_United_Arab_Emirates',
      'Category:Logistics_companies_of_the_United_Arab_Emirates',
      'Category:Real_estate_companies_of_the_United_Arab_Emirates',
      'Category:Information_technology_companies_of_the_United_Arab_Emirates',
      'Category:Financial_services_companies_of_the_United_Arab_Emirates',
      'Category:Telecommunications_companies_of_the_United_Arab_Emirates',
      'Category:Manufacturing_companies_of_the_United_Arab_Emirates',
    ],
    perCycle: 4,
    perCategory: 200,
    minIntervalMs: 2000,
  },

  // GitHub orgs by UAE location — a company with public repos has developers
  // and cloud infrastructure: the pen-testing / cloud-security profile.
  // Unauthenticated search allows 10 req/min, hence the wide interval.
  github: {
    locations: ['Dubai', 'Abu Dhabi', 'Sharjah', 'United Arab Emirates',
                'UAE', 'Ajman', 'Ras Al Khaimah', 'Fujairah'],
    perCycle: 2,
    perLocation: 25,
    minIntervalMs: 7000,
  },

  // 2c. ADGM FSRA public register (free, no key) — every financial firm the
  // regulator has licensed, with address and often a direct email/phone. An
  // FSRA licence is a standing compliance obligation, so these arrive
  // pre-qualified for the GRC service line. ~480 firms; the whole register
  // sweeps in ~5 cycles and re-sweeps are deduped away.
  adgm: {
    perPage: 50,
    pagesPerCycle: 2,     // 100 firms/cycle
    minIntervalMs: 3000,
  },

  // 3. Google News RSS (free) — breach + compliance trigger events.
  googleNews: {
    queries: [
      // breach / incident — the highest-intent trigger for a security firm
      'UAE company data breach',
      'UAE ransomware attack company',
      'Dubai data leak customers',
      'UAE cyber attack business disruption',
      // compliance triggers
      'UAE ISO 27001 certification company',
      'UAE NESA information assurance compliance',
      'Abu Dhabi ADHICS healthcare information security',
      'UAE PDPL personal data protection compliance deadline',
      // growth / new-entity triggers
      'new company licence Dubai expansion',
      'UAE fintech licence granted',
      'Dubai healthcare group new clinic',
      'UAE logistics company expansion technology',
    ],
    perQueryLimit: 10,
  },

  // 4. Firecrawl web search — template × region matrix, rotated per cycle.
  websearch: {
    templates: [
      'healthcare companies in {region}',
      'financial services companies in {region}',
      'logistics companies in {region}',
      'law firms in {region}',
      'ISO 27001 certification required {region}',
      'tender information security {region}',
      'penetration testing services {region}',
      'data protection officer {region}',
    ],
    regions: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah',
              'Fujairah', 'Umm Al Quwain', 'DMCC', 'DIFC', 'ADGM',
              'Jebel Ali Free Zone', 'Dubai Internet City'],
    perCycle: 6,          // 96-query matrix → full sweep every 16 cycles (~8 days)
    perQueryLimit: 10,
  },

  // 5. Trade-show exhibitor directories (Firecrawl scrape → markdown).
  // URLs are DATA and change yearly — live-verify each one before adding it,
  // or the source silently burns Firecrawl credits on pages with no companies.
  //
  // DISABLED 2026-08-02: none of the four candidates could be verified.
  //   gisec.ae/exhibitor-list      — 200, but the SPA serves an identical shell
  //                                  for ANY path (/why-exhibit included), and a
  //                                  JS-rendered scrape returned only marketing
  //                                  links, no company directory.
  //   visit.gisec.ae               — checked for the "catalogue on the visit
  //                                  subdomain" pattern; 23 links, none an
  //                                  exhibitor list. The 2026 edition has passed
  //                                  and no 2027 directory is published yet.
  //   www.gitex.com/exhibitor-list — renders 136 bytes: "click here → /home".
  //   www.intersecexpo.com/…       — hard 404 on /exhibitor-list and /exhibitors.
  //   seamless-middleeast.com      — domain does not resolve (no DNS at all).
  // Re-enable by adding a URL whose scrape yields a real company list, and
  // capture a fixture under fixtures/ so the extractor stays under test.
  exhibitors: {
    shows: [],
    perShowLimit: 120,
    showsPerCycle: 2,
  },

  // 6. Google Places (gated on GOOGLE_PLACES_API_KEY) — the best source of
  // phone numbers. Overlaps Overpass heavily, so it runs last and fills gaps.
  places: {
    monthlyCap: 9000,        // free SKU is 10k/mo
    perRunResultLimit: 20,
    templates: ['{sector} companies in {region}'],
    sectors: ['healthcare', 'financial services', 'legal', 'logistics',
              'insurance', 'real estate', 'education', 'e-commerce',
              'IT services'],
    regions: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah',
              'Fujairah', 'Umm Al Quwain'],
    perCycle: 4,
  },

  // ---- Paid-API budget caps (hard backstops, lib/budget.js) ----
  // Firecrawl is SHARED with the Al Khaznah project (which keeps its own
  // counter), so its cap is an explicit SPLIT of the plan, not the whole plan.
  // Apollo is Underwings' own key (added 2026-08-02, replacing Hunter whose
  // shared key sat permanently at its plan limit).
  apollo: {
    // Three counters because searches, email-reveals and org-enrichments draw
    // down different plan allowances. Worst case each spends once per kept
    // lead (~25/cycle, 2 cycles/day) plus the refresh pass — align these with
    // the actual plan tier once its monthly credit numbers are known.
    // ⚠️ Free plan (current): ONLY orgCap is spendable — people search and
    // match 403 until the plan is upgraded; their caps sit ready for that day.
    searchCap: 600,   // mixed_people/search calls per month   [paid plans]
    matchCap: 300,    // people/match email reveals per month  [paid plans]
    orgCap: 600,      // organizations/enrich calls per month  [works on Free]
  },
  firecrawl: { monthlyCap: 300 },   // of the shared 3000/mo plan

  // ---- Run behaviour ----
  // Retuned 2026-08-06 for a 5-person team with ~2h/day of sales capacity:
  // ~10 workable prospects a day beat 160 unreachable ones. Threshold up
  // (quality bar), candidate pool halved (less Haiku spend on leads nobody
  // will work), cadence once a day.
  scoreThreshold: 7,        // write only leads with icp_score >= this
  maxCandidatesPerRun: 40,
  intervalMinutes: 1440,    // 24h loop cadence
  // Size bands that never enter the pipeline as workable leads, regardless of
  // score. Prose in the ICP can be ignored by the scorer; this cannot: run.js
  // stores excluded bands as status 'disqualified' and spends no people
  // credits on them. Values must match the crm_prospects size_band CHECK.
  excludeSizeBands: ['enterprise'],
  runNowPollSeconds: 60,    // poll crm_leadgen_settings.run_requested_at this often
  claudeModel: 'claude-haiku-4-5-20251001',
  claudeBatchSize: 8,
  refresh: {
    reverifyAfterDays: 30,
    maxRowsPerCycle: 25,
  },
  // Free MX pass (lib/mx.js): a domain with no mail route means every
  // contact behind it is dead — caught by DNS before Brevo counts a bounce
  // against sender reputation. Per-cycle cap keeps DNS traffic polite; the
  // ~5.5k-domain blead backlog was cleared once by verify-mx-sweep.js.
  mx: {
    domainsPerCycle: 150,
    recheckDays: 60,
    concurrency: 10,
  },
  outreach: {
    backfillPerCycle: 40,   // draft-less existing rows re-drafted per cycle
  },
  contacts: {
    // A large UAE site publishes every branch inbox and account manager —
    // one company came back with 40 addresses. Keep the primary plus the
    // best few; more than this buries the useful ones in the drawer.
    maxPerProspect: 12,
  },
  // Collaboration track: firms to partner with, not sell to. 5/cycle × 2
  // cycles/day = ~10/day, deliberately small — see run.js selectLeads().
  partners: {
    perCycle: 5,
    scoreThreshold: 6,
  },

  // ---- Sales status flow ----
  // Mirrors the crm_prospects status CHECK in migration 011. The pipeline only
  // ever seeds 'new'; everything past that belongs to the sales team.
  salesStatuses: ['new', 'enriched', 'contacted', 'replied', 'qualified',
                  'disqualified', 'promoted', 'suppressed'],
};
