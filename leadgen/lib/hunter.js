'use strict';
/*
 * hunter.js — Hunter.io domain-search → the best NAMED-PERSON contact.
 * Gated: returns null unless a key is passed. Picks the most senior/relevant
 * person and tags an email status from Hunter's confidence (its deliverability
 * estimate). Optionally verifies the chosen email via Hunter's verifier.
 */
const { getJson } = require('./http');

const DECISION_MAKER = /\b(ceo|founder|co-founder|owner|cto|ciso|cio|cfo|coo|chief|vp|vice president|head|director|manager|it\b|information security|security)\b/i;

function statusFromConfidence(c) {
  if (c >= 90) return 'verified';
  if (c >= 70) return 'probable';
  if (c > 0) return 'low';
  return '';
}

/** @returns {Promise<null|{email,name,title,confidence,linkedin,status,all:string[]}>} */
async function findContact(domain, key) {
  if (!key || !domain) return null;
  try {
    // Free plan caps domain-search at 10 results.
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}` +
                `&limit=10&api_key=${encodeURIComponent(key)}`;
    const j = await getJson(url, {}, { timeoutMs: 25000, retries: 1 });
    const people = j.data?.emails || [];
    if (!people.length) return null;
    // rank: decision-maker title first, then confidence
    const rank = (p) => (DECISION_MAKER.test(p.position || '') ? 1000 : 0) + (p.confidence || 0);
    const best = people.slice().sort((a, b) => rank(b) - rank(a))[0];
    return {
      email: best.value || '',
      name: [best.first_name, best.last_name].filter(Boolean).join(' '),
      title: best.position || '',
      confidence: best.confidence || 0,
      linkedin: best.linkedin || '',
      status: statusFromConfidence(best.confidence || 0),
      all: [...new Set(people.map((p) => p.value).filter(Boolean))],
    };
  } catch {
    return null;
  }
}

// Normalize Hunter's verifier vocabulary → a clean, sortable status set used by
// the sheet colors + Dashboard ("verified" / "risky" / "invalid").
const VERIFY_MAP = {
  valid: 'verified', webmail: 'verified',
  accept_all: 'risky', unknown: 'risky',
  invalid: 'invalid', disposable: 'invalid',
};

/** Optional true verification (uses a Hunter credit). */
async function verify(email, key) {
  if (!key || !email) return 'risky';
  try {
    const j = await getJson(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}` +
      `&api_key=${encodeURIComponent(key)}`, {}, { timeoutMs: 25000, retries: 1 });
    const raw = j.data?.status || 'unknown';
    return VERIFY_MAP[raw] || raw;
  } catch {
    return 'risky';
  }
}

module.exports = { findContact, verify };
