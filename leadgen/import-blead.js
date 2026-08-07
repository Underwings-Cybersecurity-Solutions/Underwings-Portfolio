'use strict';
/* import-blead.js — one-off (2026-08-07): bulk-import the user-supplied
 * outbound lists staged at state/blead/*.csv into crm_prospects as
 * kind='blead' (the CRM's BLead tab).
 *
 *   docker exec underwings-leadgen node import-blead.js
 *
 * What gets in: every distinct company with at least one usable email OR a
 * real web domain. Everything else — and every provenance column (list
 * labels, owner mailboxes, rationale/valuation text) — is dropped here and
 * never reaches the database; the list-owner organisations themselves and
 * their mail domains are excluded outright (PROVENANCE below).
 *
 * Scoring is a deterministic heuristic (no API spend), documented at
 * scoreOf(). Writes go through store.upsertLeads() — the same tested path as
 * the pipeline: global dedupe on dedupe_key (existing prospects always win),
 * contacts deduped on (prospect_id, email).
 */
const fs = require('fs');
const path = require('path');
const store = require('./lib/store-pg');
const { normCompany } = require('./lib/parse');

const DIR = path.join(__dirname, 'state', 'blead');
const BATCH = 500;

// The organisations the lists came from: no company named after them, no
// contact on their mail domains, no mention in any stored field.
const PROVENANCE = /\b(qrs|tqs|gcee)/i;

const FREEMAIL = /@(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|icloud|me|aol|protonmail|proton|zoho|mail|gmx|rediffmail|yandex)\.[a-z.]+$/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+/gi;
const JUNK_EMAIL = /^(mailer-daemon|postmaster|noreply|no-reply|donotreply|abuse|bounce)/i;
const UAE_RE = /\b(uae|u\.a\.e|united arab emirates|dubai|abu dhabi|sharjah|ajman|umm al|ras al|fujairah|al ain|musaffah|jebel ali)\b/i;

/* ---------- CSV ---------- */

function parseCSV(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function loadCSV(file, { fixStrayQuotes = false } = {}) {
  let text = fs.readFileSync(path.join(DIR, file), 'utf8');
  // customers-all uses a single bare `"` as an empty-email placeholder, which
  // opens a quote that swallows following rows. A field that is exactly one
  // double-quote (`,",` / `,"⏎`) is corruption, not quoting — neutralise it.
  if (fixStrayQuotes) text = text.replace(/,"(?=,)/g, ',').replace(/,"(?=\r?\n)/g, ',');
  const rows = parseCSV(text);
  const header = rows[0];
  return rows.slice(1)
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

/* ---------- field cleaning ---------- */

function emailsOf(raw) {
  const found = String(raw || '').match(EMAIL_RE) || [];
  const out = [];
  for (let e of found) {
    e = e.toLowerCase().replace(/\.+$/, '');
    if (JUNK_EMAIL.test(e)) continue;
    if (PROVENANCE.test(e.split('@')[1])) continue;   // list-owner mail domains
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

const isCorp = (e) => !FREEMAIL.test(e);

function cleanName(raw) {
  const n = String(raw || '')
    .replace(/^\s*(mr|ms|mrs|dr|eng|er)\s*[.\s]\s*/i, '')
    .replace(/\s+/g, ' ').trim();
  if (!n || /^n\/?a$/i.test(n) || n.length < 2 || /@/.test(n)) return '';
  return n;
}

function cleanIndustry(raw) {
  const s = String(raw || '')
    // analyst annotations — "(inferred from X's pitch)", "(likely …)" — are
    // noise and can name the list owner; only the plain label survives
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+/g, ' ').trim();
  if (!s || /^unknown/i.test(s) || PROVENANCE.test(s)) return '';
  return s.slice(0, 120);
}

const yearOf = (s) => parseInt(String(s || '').slice(0, 4), 10) || 0;

/** Prefer the email that looks like it belongs to the named person, so the
 * salutation and the inbox line up ("Mr. Salman" → salman@…). */
function pickPrimaryEmail(emails, name) {
  if (!emails.length) return '';
  const tokens = (name || '').toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 2);
  const personal = emails.find((e) => tokens.some((t) => e.split('@')[0].includes(t)));
  return personal || emails.find(isCorp) || emails[0];
}

/* ---------- heuristic score (1–9, ai_score) ---------- */

function scoreOf(c) {
  let s = 5;
  if (c.contactName) s += 2;                        // a human to write to
  if (c.emails.some(isCorp)) s += 1;                // corporate inbox
  if (c.title) s += 1;                              // we know their role
  if (c.lastYear >= 2025) s += 1;                   // recently active record
  if (!c.emails.length) s -= 2;                     // domain-only, needs enrichment
  else if (!c.emails.some(isCorp)) s -= 1;          // freemail-only
  return Math.max(1, Math.min(9, s));
}

function whyOf(c) {
  const bits = [];
  if (c.contactName) bits.push('named contact');
  if (c.emails.some(isCorp)) bits.push('corporate email');
  else if (c.emails.length) bits.push('freemail only');
  else bits.push('domain only — awaiting contact enrichment');
  if (c.lastYear >= 2025) bits.push(`active ${c.lastYear}`);
  return `imported list — ${bits.join(', ')}`;
}

/* ---------- merge ---------- */

function keyOf(c) { return c.domain ? `d:${c.domain}` : `c:${normCompany(c.company)}`; }

function merge(into, from) {
  if (!into.contactName && from.contactName) {
    into.contactName = from.contactName; into.title = from.title;
  }
  if (!into.title && from.title) into.title = from.title;
  if (!into.industry && from.industry) into.industry = from.industry;
  if (!into.location && from.location) into.location = from.location;
  if (!into.phone && from.phone) into.phone = from.phone;
  for (const e of from.emails) if (!into.emails.includes(e)) into.emails.push(e);
  into.lastYear = Math.max(into.lastYear, from.lastYear);
}

(async () => {
  const stats = { rows: 0, noReach: 0, owner: 0, contactsLinked: 0, contactsLoose: 0 };
  const companies = new Map();   // keyOf → candidate
  const byDomain = new Map();    // domain → candidate (for contact linking)

  function add(c) {
    c.company = c.company.replace(/\s+/g, ' ').trim();
    if (!c.company) return;
    if (PROVENANCE.test(c.company)) { stats.owner++; return; }
    if (!c.domain && c.emails.length) {
      const corp = c.emails.find(isCorp);
      if (corp) c.domain = corp.split('@')[1];
    }
    if (!c.domain && !c.emails.length) { stats.noReach++; return; }
    const k = keyOf(c);
    if (companies.has(k)) merge(companies.get(k), c);
    else companies.set(k, c);
    if (c.domain && !byDomain.has(c.domain)) byDomain.set(c.domain, companies.get(k));
  }

  // registry list (broken quoting; provenance columns never read)
  for (const r of loadCSV('customers-all.csv', { fixStrayQuotes: true })) {
    stats.rows++;
    const emails = emailsOf(r.Email);
    add({
      company: r.Company || '', contactName: cleanName(r.Contact), title: '',
      emails, domain: '', industry: '', location: '', phone: '',
      lastYear: yearOf(r.Added),
    });
  }

  // mailbox-mined companies (Type/Owner Mailbox/Rationale/Est.Value never read)
  for (const r of loadCSV('ci-companies.csv')) {
    stats.rows++;
    const domain = (r.Domain || '').toLowerCase();
    add({
      company: r.Company || '', contactName: '', title: '',
      emails: [], domain: FREEMAIL.test(`@${domain}`) ? '' : domain,
      industry: cleanIndustry(r.Industry), location: r.Location || '', phone: '',
      lastYear: yearOf(r['Last Contact']),
    });
  }

  // mailbox-mined people → attach to their company by email domain
  for (const r of loadCSV('ci-contacts.csv')) {
    stats.rows++;
    const emails = emailsOf(r.Email);
    const target = emails.map((e) => byDomain.get(e.split('@')[1])).find(Boolean);
    if (!target) { stats.contactsLoose++; continue; }
    stats.contactsLinked++;
    merge(target, {
      contactName: cleanName(r.Name), title: (r.Title || '').slice(0, 80),
      emails, industry: '', location: '', lastYear: yearOf(r['Last Contact']),
      phone: r.Mobile || r.Phone || '',
    });
  }

  // candidate → pipeline lead shape (store-pg.toProspectRow / toContactRows)
  const leads = [...companies.values()].map((c) => {
    const email = pickPrimaryEmail(c.emails, c.contactName);
    return {
      company: c.company,
      website: c.domain ? `https://${c.domain}` : '',
      industry: c.industry || '',
      location: c.location || '',
      country: UAE_RE.test(c.location) ? 'United Arab Emirates' : '',
      kind: 'blead',
      source: 'blead-import',
      icp_score: scoreOf(c),
      why: whyOf(c),
      email,
      emails: c.emails.filter((e) => e !== email),
      contactName: c.contactName || '',
      title: c.title || '',
      phone: c.phone || '',
      contactSource: 'import',
      confidence: c.contactName && email ? 35 : undefined,
    };
  });

  console.log(`parsed ${stats.rows} rows → ${companies.size} distinct companies`);
  console.log(`skipped: ${stats.noReach} with no email/domain, ${stats.owner} list-owner names, ` +
    `${stats.contactsLoose} unlinkable loose contacts (${stats.contactsLinked} contacts linked)`);

  let inserted = 0;
  for (let i = 0; i < leads.length; i += BATCH) {
    inserted += await store.upsertLeads(leads.slice(i, i + BATCH));
    console.log(`  upserted ${Math.min(i + BATCH, leads.length)}/${leads.length} (${inserted} new)`);
  }
  console.log(`Done: ${inserted} new blead prospects (${leads.length - inserted} were already known)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
