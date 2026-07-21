'use strict';
/*
 * contacts.js — free email/phone harvester.
 * Aggressively scrapes a company's own web presence (homepage + contact/about/
 * team pages it can discover) and pulls every email + tel: phone it finds.
 * Lawful, no API key. This is the Phase-1 enrichment engine.
 */
const { getText } = require('./http');
const P = require('./parse');

const CANDIDATE_PATHS = [
  '', '/contact', '/contact-us', '/contactus', '/contact.html',
  '/about', '/about-us', '/team', '/our-team', '/people',
  '/impressum', '/support', '/get-in-touch',
];
const ROLE_PREFIXES = ['info@', 'sales@', 'contact@', 'hello@', 'enquiry@',
                       'enquiries@', 'admin@', 'support@', 'office@'];

/** tel: links → cleaned phone strings (reliable, vs scraping random numbers). */
function extractTelephones(html) {
  const out = new Set();
  const re = /href=["']tel:([^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const p = m[1].replace(/[^\d+]/g, '');
    if (p.replace(/\D/g, '').length >= 7) out.add(m[1].trim());
  }
  return [...out];
}

/** Internal links whose href hints at a contact/about page. */
function discoverContactLinks(html, origin) {
  const out = new Set();
  const re = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (/contact|about|team|impressum|people/i.test(m[1])) {
      try { out.add(new URL(m[1], origin).href); } catch { /* skip */ }
    }
  }
  return [...out].slice(0, 6);
}

/** Pick the most outreach-useful email (prefer role addresses on the company domain). */
function bestEmail(emails, domain) {
  if (!emails.length) return '';
  const d = (domain || '').toLowerCase().replace(/^www\./, '');
  const onDomain = d ? emails.filter((e) => e.endsWith('@' + d)) : [];
  const pool = onDomain.length ? onDomain : emails;
  for (const pre of ROLE_PREFIXES) {
    const hit = pool.find((e) => e.startsWith(pre));
    if (hit) return hit;
  }
  return [...pool].sort((a, b) => a.length - b.length)[0];
}

/**
 * Harvest contacts for a website.
 * @returns {Promise<{emails:string[], phones:string[], best:string, source:string}>}
 */
async function harvestContacts(website, seedPhone = '') {
  let origin;
  try { origin = new URL(website).origin; }
  catch { return { emails: [], phones: seedPhone ? [seedPhone] : [], best: '', source: '' }; }

  const emails = new Set();
  const phones = new Set();
  if (seedPhone) phones.add(seedPhone);

  // homepage first, then discover contact-ish links, then known paths
  let home = '';
  try { home = await getText(origin, {}, { timeoutMs: 12000, retries: 1 }); } catch { /* */ }
  P.extractEmails(home).forEach((e) => emails.add(e));
  extractTelephones(home).forEach((p) => phones.add(p));

  const urls = new Set([
    ...discoverContactLinks(home, origin),
    ...CANDIDATE_PATHS.map((p) => origin + p),
  ]);
  urls.delete(origin); // already fetched

  for (const u of urls) {
    if (emails.size >= 15) break;
    let html = '';
    try { html = await getText(u, {}, { timeoutMs: 9000, retries: 0 }); } catch { continue; }
    P.extractEmails(html).forEach((e) => emails.add(e));
    extractTelephones(html).forEach((p) => phones.add(p));
  }

  const cleanEmails = [...emails].filter(
    (e) => !/\.(png|jpe?g|gif|svg|webp)$/i.test(e) && e.length <= 80
  );
  const domain = origin.replace(/^https?:\/\/(www\.)?/, '');
  return {
    emails: cleanEmails,
    phones: [...phones].slice(0, 3),
    best: bestEmail(cleanEmails, domain),
    source: cleanEmails.length || phones.size ? 'website-scrape' : '',
  };
}

module.exports = { harvestContacts, bestEmail, extractTelephones };
