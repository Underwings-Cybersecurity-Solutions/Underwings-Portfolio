'use strict';
/*
 * leadgen/config.js — single place to tune the lead generator.
 * Edit ICP / sectors / categories here; no code changes needed.
 */
module.exports = {
  // ---- Who we're looking for (Claude scores against this) ----
  icp: {
    description:
      'UAE-based small-to-mid businesses in regulated or data-sensitive ' +
      'sectors (finance, banking, insurance, healthcare, legal, real estate, ' +
      'logistics, technology/IT, government-adjacent) that plausibly need ' +
      'cybersecurity services: ISO 27001 / GRC, penetration testing (PTaaS), ' +
      'cloud security, or security awareness training.',
    // Underwings services Claude can map a lead to:
    services: ['GRC / ISO 27001', 'PTaaS / Pen Testing', 'Cloud Security',
               'Network & Infrastructure', 'Training & Awareness'],
    geo: 'United Arab Emirates',
  },

  // ---- Source tuning ----
  overpass: {
    iso: 'AE',
    // OSM office/amenity categories that map to our target sectors.
    officeCategories: ['company', 'it', 'financial', 'insurance', 'lawyer',
                       'accountant', 'consulting', 'logistics', 'government'],
    amenityCategories: ['bank', 'hospital', 'clinic', 'pharmacy'],
    perCategoryLimit: 60,
  },
  wikidata: { limit: 150 },
  places: {
    // Google Places API (New) — gated on GOOGLE_PLACES_API_KEY.
    monthlyCap: 9000,          // hard billing backstop (free SKU = 10k/mo); real use ~480/mo
    perRunResultLimit: 20,     // results requested per text query
    queries: ['IT companies in Dubai', 'financial services Abu Dhabi',
              'private hospitals UAE', 'law firms Dubai'],
  },
  hunter: {
    // Hunter.io → named person emails. Gated on HUNTER_API_KEY. Free plan =
    // 50 searches + 100 verifications / month → separate monthly budgets.
    // Leads are processed top-AI-score first, so the budget is spent on the best.
    searchCap: 45,             // domain-search calls/month (buffer under 50)
    verifyCap: 95,             // email-verifier calls/month (buffer under 100)
    verify: true,              // verify each found email → real deliverability status
  },
  googleNews: {
    // Intent / trigger-event queries (free RSS, no key).
    queries: [
      'UAE company data breach', 'UAE cybersecurity compliance',
      'UAE new headquarters opening', 'UAE fintech funding',
      'Dubai healthcare expansion', 'Abu Dhabi bank technology',
    ],
    perQueryLimit: 15,
  },

  // ---- Run behaviour ----
  maxCandidatesPerRun: 50,   // cap to control cost/time per cycle
  intervalMinutes: 360,      // continuous loop cadence (6h) when run with --loop
  claudeModel: 'claude-haiku-4-5-20251001',
  claudeBatchSize: 8,

  // ---- Sheet ----
  sheet: {
    id: '1hPvWyTclZbB6G3uL-cDJROQrfIIuRgWbbM5oc0_TIr0',
    tab: 'OSINT_LEADS',          // unified lean tab (contacts + osint security signal)
    headerRow: 1,
    firstDataRow: 2,
    // Lean sales layout — 17 cols A–Q. leadgen owns A–L, O–Q; osint owns M, N.
    // A # | B Company | C Contact Name | D Title | E Email | F Email Status |
    // G Phone | H LinkedIn | I Website | J Industry | K Service | L AI Score |
    // M Gap Score(osint) | N Security Talking Points(osint) | O Status | P Notes | Q Date Added
  },
};
