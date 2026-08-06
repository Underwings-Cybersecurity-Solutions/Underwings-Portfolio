'use strict';
/*
 * apollo.js — Apollo.io → the best NAMED person to approach about security
 * and compliance work. Replaces Hunter.io (whose shared key sat permanently
 * at its plan limit, so v2 shipped with named contacts dark).
 *
 * Current API contract (verified against docs.apollo.io 2026-08-02 — the
 * 2024-era one is DEAD: `mixed_people/search` is gone from the docs, params
 * moved to the query string, and search responses carry no emails at all,
 * only `has_email` booleans and obfuscated last names):
 *   findPerson(domain, key)  — POST mixed_people/api_search, decision-maker
 *                              titles filtered server-side. 0 credits, but
 *                              rate-limited, hence budgeted. ['apollo-search']
 *   reveal(person, key)      — POST people/match?id=… ; returns the full
 *                              person incl. work email + email_status. THIS
 *                              is the credit-consuming call. ['apollo-match']
 *   enrichByEmail(email, key)— people/match keyed on an email; the refresh
 *                              pass uses it to re-check a stored address.
 *                              Same contract as Hunter's verify().
 *   enrichOrg(domain, key)   — organizations/enrich: firmographics (industry,
 *                              headcount, location).           ['apollo-org']
 *
 * Apollo emails arrive with their own email_status, so there is no separate
 * verifier step — STATUS_MAP folds Apollo's vocabulary into the pipeline's
 * (valid / accept_all / unknown / invalid, same as Hunter produced).
 *
 * PLAN GATE (live-verified 2026-08-02, key on the Free plan): people search,
 * people/match and company search all return 403 API_INACCESSIBLE on Free —
 * "All paid plans include full API access". ONLY organizations/enrich works.
 * The people functions are still wired: they log the 403 and return null, so
 * the pipeline runs scrape+org-enrich-only today and named contacts light up
 * automatically when the plan is upgraded. No code change needed then.
 */
const { getJson } = require('./http');

const BASE = 'https://api.apollo.io/api/v1';

// Server-side search bias. Apollo's person_titles also matches adjacent
// titles, so this narrows without excluding the owner-operator at a 40-person
// firm — exactly who signs off security spend in our ICP.
const SEARCH_TITLES = [
  'CISO', 'CIO', 'CTO', 'IT Manager', 'IT Director', 'Head of IT',
  'Information Security Manager', 'Compliance Manager', 'Risk Manager',
  'Data Protection Officer', 'CEO', 'Managing Director', 'General Manager',
];

// Client-side ranking over whatever the search returns (same tiers the Hunter
// integration used): the security/IT/compliance owner first, then a general
// executive, then everyone else.
const SECURITY_BUYER =
  /\b(ciso|cio|cto|chief information|chief technology|chief security|information security|infosec|cyber ?security|security officer|it manager|it director|it head|head of it|head of technology|compliance|risk|governance|grc|dpo|data protection|internal audit|quality manager|qhse)\b/i;
const EXEC =
  /\b(ceo|founder|co-founder|owner|managing director|president|chief|coo|cfo|vp|vice president|head|director|manager|partner|general manager)\b/i;

/** Pure ranking: security/compliance titles 2000 > exec titles 1000. Apollo
 * has no per-person confidence number, so tier order is the whole signal. */
function rank(p) {
  const t = (p && p.title) || '';
  return (SECURITY_BUYER.test(t) ? 2000 : 0) + (EXEC.test(t) ? 1000 : 0);
}

// Apollo email_status → the pipeline's fixed vocabulary (what Hunter's
// verifier produced; lib/store-pg.js maps it onto the DB CHECK values).
// Current docs type email_status as an OPEN string and enumerate only
// verified / unverified / likely to engage / unavailable — anything not
// mapped here degrades to 'unknown' rather than being trusted.
const STATUS_MAP = {
  verified: 'valid',
  likely_to_engage: 'valid',
  'likely to engage': 'valid',
  guessed: 'accept_all',
  extrapolated: 'accept_all',
  unverified: 'unknown',
  unavailable: 'unknown',
  bounced: 'invalid',
  do_not_contact: 'invalid',
};

// Legacy plans returned this placeholder in place of a real address; current
// docs no longer mention it, but guarding costs nothing.
const LOCKED = /email_not_unlocked/i;
function usableEmail(e) { return e && !LOCKED.test(String(e)) ? String(e) : ''; }

// ---- plan gate ----
// The Free plan 403s every people endpoint with error_code API_INACCESSIBLE.
// Without a latch, every kept lead burns an apollo-search budget slot and a
// log line on a guaranteed failure. First such 403 disables people calls for
// the rest of the PROCESS — after a plan upgrade, restart the service
// (`docker compose restart leadgen`) to re-probe.
let peopleBlocked = false;

/** Is this error Apollo saying the endpoint isn't in the plan? Pure. */
function isPlanError(e) {
  return /API_INACCESSIBLE|not included in your\b.*\bplan/i.test(String((e && e.message) || e || ''));
}

// Organisations/enrich is the one endpoint the Free plan allows, but it still
// runs on a credit balance — once that is spent every call 422s with
// "insufficient credits". Without its own latch this repeats for every lead
// of every cycle: a spent budget slot and a live HTTP call, both guaranteed
// to fail. Separate from the people latch because the two run out
// independently, and a credit top-up should revive org enrichment even while
// the people endpoints stay paywalled.
let orgBlocked = false;

/** Is this Apollo saying the credit balance is empty? Pure. */
function isCreditError(e) {
  return /insufficient credits/i.test(String((e && e.message) || e || ''));
}
function planBlocked() { return peopleBlocked; }
function orgCreditsBlocked() { return orgBlocked; }
function noteError(e, label) {
  if (isPlanError(e) && !peopleBlocked) {
    peopleBlocked = true;
    console.warn('  [apollo] people endpoints are not in this plan — skipping them for the rest of this run (restart after upgrading)');
  } else {
    console.warn(`  [apollo:${label}] ${e.message}`);
  }
}
/** Test seams. */
function _setPlanBlocked(v) { peopleBlocked = !!v; }
function _setOrgBlocked(v) { orgBlocked = !!v; }

/** Query-string builder — the current API takes parameters in the query even
 * on POST, with arrays as repeated `key[]` entries. Pure; exported for tests. */
function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const item of v) sp.append(`${k}[]`, item);
    else sp.append(k, String(v));
  }
  return sp.toString();
}

/** Confidence stand-in (Hunter had a 0-100 number; Apollo does not). Derived
 * from the revealed status so "best contact first" ordering still works. */
function confidenceOf(status) {
  return status === 'valid' ? 95 : status === 'accept_all' ? 70 : 40;
}

function headers(key) {
  return { 'Content-Type': 'application/json', 'X-Api-Key': key };
}

/** Apollo person → the pipeline's contact shape, or null when the email is
 * missing/locked — or known-bad: a bounced/do_not_contact address must never
 * become the prospect's contact, where it would overwrite a working scraped
 * role email and (being 'invalid') be excluded from re-verification forever.
 * Pure; reveal() and run.js both use it. */
function normalize(person) {
  if (!person) return null;
  const email = usableEmail(person.email);
  if (!email) return null;
  const status = STATUS_MAP[person.email_status] || 'unknown';
  if (status === 'invalid') return null;
  return {
    email,
    name: person.name || [person.first_name, person.last_name].filter(Boolean).join(' '),
    title: person.title || '',
    confidence: confidenceOf(status),
    linkedin: person.linkedin_url || '',
    status,
  };
}

/** Best-ranked person WITH an email at a domain, or null. 0 credits (search
 * is free on current pricing) but rate-limited — the CALLER budgets it
 * ('apollo-search'). Response people carry no emails, only `has_email`;
 * filtering on it keeps reveal credits off people Apollo can't deliver. */
async function findPerson(domain, key) {
  if (!key || !domain || peopleBlocked) return null;
  try {
    const query = qs({
      q_organization_domains_list: [domain],
      person_titles: SEARCH_TITLES,
      per_page: 10,
      page: 1,
    });
    const j = await getJson(`${BASE}/mixed_people/api_search?${query}`, {
      method: 'POST',
      headers: headers(key),
    }, { timeoutMs: 30000, retries: 1 });
    const people = (j.people || []).filter((p) => p && p.has_email !== false);
    if (!people.length) return null;
    return people.slice().sort((a, b) => rank(b) - rank(a))[0];
  } catch (e) {
    noteError(e, `search:${domain}`);
    return null;
  }
}

/** Reveal the person's work email via people/match. THIS call consumes the
 * credit (1 when email/demographics are found) — the CALLER budgets it
 * ('apollo-match'). Never asks for personal emails. */
async function reveal(person, key) {
  if (!key || !person || !person.id || peopleBlocked) return normalize(person);
  try {
    const query = qs({ id: person.id, reveal_personal_emails: false });
    const j = await getJson(`${BASE}/people/match?${query}`, {
      method: 'POST',
      headers: headers(key),
    }, { timeoutMs: 30000, retries: 1 });
    return normalize(j.person) || normalize(person);
  } catch (e) {
    noteError(e, `match:${person.id}`);
    return normalize(person);
  }
}

/** Fold a raw email_status into a re-verification VERDICT: a definitive
 * pipeline status, or the 'unverified' sentinel when Apollo has no data.
 * Distinct from STATUS_MAP-on-a-reveal: there, "no data" is still an email
 * of unknown quality worth storing ('unknown' → 'low'); here it is the
 * absence of a verdict, and the caller must leave stored state alone rather
 * than re-stamp verified_at on zero evidence. Pure; exported for tests. */
function verdictOf(raw) {
  const mapped = raw && STATUS_MAP[raw];
  return mapped && mapped !== 'unknown' ? mapped : 'unverified';
}

/** Re-check a stored email. Returns the pipeline status vocabulary, or
 * 'unverified' when Apollo can't say — the same contract Hunter's verify()
 * had, so the refresh pass logic is unchanged. Spends one email credit. */
async function enrichByEmail(email, key) {
  if (!key || !email || peopleBlocked) return 'unverified';
  try {
    const query = qs({ email, reveal_personal_emails: false });
    const j = await getJson(`${BASE}/people/match?${query}`, {
      method: 'POST',
      headers: headers(key),
    }, { timeoutMs: 30000, retries: 1 });
    return verdictOf(j.person && j.person.email_status);
  } catch (e) {
    noteError(e, 'verify');
    return 'unverified';
  }
}

/** Firmographics by domain — the one endpoint the Free plan allows. Spends
 * one enrichment credit — the CALLER budgets it ('apollo-org'). */
async function enrichOrg(domain, key) {
  if (!key || !domain || orgBlocked) return null;
  try {
    const j = await getJson(
      `${BASE}/organizations/enrich?domain=${encodeURIComponent(domain)}`,
      { method: 'GET', headers: headers(key) },
      { timeoutMs: 30000, retries: 1 });
    const o = j.organization;
    if (!o) return null;
    return {
      industry: o.industry || '',
      employees: typeof o.estimated_num_employees === 'number' ? o.estimated_num_employees : null,
      city: o.city || '',
      country: o.country || '',
      linkedin: o.linkedin_url || '',
      website: o.website_url || '',
    };
  } catch (e) {
    if ((isCreditError(e) || isPlanError(e)) && !orgBlocked) {
      orgBlocked = true;
      console.warn('  [apollo] organisation enrichment is out of credits — skipping it for the rest of this run (restart after topping up)');
    } else if (!orgBlocked) {
      console.warn(`  [apollo:org:${domain}] ${e.message}`);
    }
    return null;
  }
}

/** Headcount → the crm_prospects.size_band CHECK values. */
function sizeBandOf(n) {
  if (typeof n !== 'number' || n <= 0) return null;
  if (n < 30) return 'sub30';
  if (n < 250) return 'sme';
  if (n < 1000) return 'midmarket';
  return 'enterprise';
}

module.exports = {
  findPerson, reveal, enrichByEmail, enrichOrg, normalize, rank, sizeBandOf, qs,
  planBlocked, isPlanError, _setPlanBlocked, verdictOf,
  orgCreditsBlocked, isCreditError, _setOrgBlocked,
  STATUS_MAP, SEARCH_TITLES, SECURITY_BUYER, EXEC, usableEmail, confidenceOf,
};
