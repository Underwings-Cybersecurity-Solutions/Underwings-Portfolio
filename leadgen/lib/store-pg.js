'use strict';
/*
 * store-pg.js — crm_prospects / crm_prospect_contacts as the system of record.
 * Replaces AKL's JSON store (and, before it, the Google Sheet) and keeps the
 * same small interface so run.js's cycle logic is unchanged:
 *
 *   load()                  → { leads: [...] }   (record shape, for dedupe+refresh)
 *   upsertLeads(records)    → number actually inserted
 *   updateSales(id, f)      → boolean            (status/notes — sales only)
 *   updateEnrichment(id, f) → boolean            (contact/enrichment columns only)
 *   idOf(lead)              → 'd:<domain>' | 'c:<normcompany>'
 *
 * The sales/enrichment field split is ALSO enforced in Postgres (migration 011
 * grants `authenticated` UPDATE on status+notes only). The allowlists here are
 * the second half of that invariant: they stop the pipeline, which runs as
 * service_role and therefore *could* write anything, from ever touching a
 * human's status or notes.
 *
 * Deliberate deviation from AKL's store.js: load() THROWS on a transport
 * error instead of returning an empty store. An empty store silently disables
 * dedupe, and the next stage spends Claude credits re-scoring companies we
 * already have. Failing the cycle is cheaper; run.js's loop retries.
 */
const cfg = require('../config');
const db = require('./supabase');
const { domainOf, normCompany } = require('./parse');
const { bucketOf } = require('./region');

const norm = normCompany;   // legal-suffix aware — see lib/parse.js
const PAGE = 1000;

/** `d:<domain>` when the lead has a resolvable website, else `c:<norm(company)>`. */
function idOf(lead) {
  const d = domainOf(lead && lead.website);
  return d ? `d:${d}` : `c:${norm(lead && lead.company)}`;
}

// Hunter's verifier vocabulary → the crm_prospect_contacts.email_status CHECK
// ('verified','probable','role','low','risky','invalid'). Anything we did not
// actually verify must NOT claim to be verified.
const EMAIL_STATUS = {
  valid: 'verified',
  accept_all: 'probable',
  unknown: 'low',
  invalid: 'invalid',
  risky: 'risky',
};
const ROLE_ADDRESS =
  /^(info|sales|contact|admin|support|hello|enquiry|enquiries|office|marketing|general)@/i;

function contactEmailStatus(lead) {
  const mapped = EMAIL_STATUS[lead.emailStatus];
  if (mapped) return mapped;
  if (lead.email && ROLE_ADDRESS.test(lead.email)) return 'role';
  return 'low';
}

/** Where the contact actually came from — matches the source CHECK
 * (migration 012 added 'apollo'; 'hunter' remains for pre-switch rows). */
function contactSource(lead) {
  if (lead.contactName) return 'apollo';   // only Apollo yields a named person
  if (lead.email) return 'scrape';
  return 'search';
}

/** UAE emirate from a free-text location string, else null. */
const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain',
                  'Ras Al Khaimah', 'Fujairah'];
function emirateOf(location) {
  const s = String(location || '');
  return EMIRATES.find((e) => new RegExp(e.replace(/ /g, '\\s*'), 'i').test(s)) || null;
}

/** Pipeline lead → a crm_prospects row. */
function toProspectRow(lead) {
  const website = lead.website || '';
  return {
    company_name: lead.company,
    domain: domainOf(website) || null,
    website: website || null,
    industry: lead.industry || null,
    size_band: lead.sizeBand || null,
    emirate: lead.emirate || emirateOf(lead.location || lead.country),
    country: lead.country || null,
    geo_bucket: bucketOf(lead.country || 'United Arab Emirates'),
    service: lead.service || null,
    kind: lead.kind === 'partner' ? 'partner' : 'customer',
    ai_score: typeof lead.icp_score === 'number' ? lead.icp_score : null,
    why: lead.why || null,
    signal: lead.signal || null,
    source: lead.source || null,
    dedupe_key: idOf(lead),
    enrichment_status: 'enriched',
    status: 'new',
    verified_at: lead.emailStatus && lead.emailStatus !== 'unverified'
      ? new Date().toISOString() : null,
    last_seen_at: new Date().toISOString(),
    // Initial AI draft only — from here on these columns are sales-owned
    // (migration 013), and the pipeline may only fill them where NULL.
    outreach_subject: lead.outreachSubject || null,
    outreach_body: lead.outreachBody || null,
  };
}

// Addresses are stored lower-cased: migration 015's uniqueness index is on
// the plain column (PostgREST's on_conflict can't name an expression), so
// normalising here is what makes "Info@x.ae" and "info@x.ae" one contact.
const normEmail = (e) => (e ? String(e).trim().toLowerCase() : '');

/** Pipeline lead → a crm_prospect_contacts row, or null if we know no one. */
function toContactRow(lead, prospectId) {
  if (!lead.email && !lead.phone && !lead.contactName) return null;
  return {
    prospect_id: prospectId,
    name: lead.contactName || null,
    job_title: lead.title || null,
    email: normEmail(lead.email) || null,
    email_status: lead.email ? contactEmailStatus(lead) : null,
    phone: lead.phone || null,
    linkedin_url: lead.linkedin || null,
    source: contactSource(lead),
    confidence: lead.confidence || null,
  };
}

/** EVERY way we can reach this company, one row each — the primary contact
 * plus every other address and phone the scrape found. Sales work a real
 * company by trying several inboxes (info@ bounces, accounts@ answers), so
 * throwing the extras away was throwing away the point of harvesting them.
 *
 * Ordering matters downstream: `confidence` decides which row the CRM shows
 * as "the" contact and which one refreshExisting re-verifies, so the primary
 * keeps its own confidence and the extras are ranked below it — role
 * addresses above generic ones. Pure; exported for tests. */
function toContactRows(lead, prospectId, maxRows = cfg.contacts.maxPerProspect) {
  const rows = [];
  const seenEmail = new Set();
  const primary = toContactRow(lead, prospectId);
  if (primary) {
    // A scraped primary carries no confidence number, and a NULL would sort
    // it BELOW its own extras under `confidence.desc.nullslast` — i.e. the
    // address bestEmail() deliberately chose would stop being "the" contact.
    if (primary.email && primary.confidence == null) primary.confidence = 30;
    rows.push(primary);
    if (primary.email) seenEmail.add(primary.email);   // already normalised
  }
  const extraPhones = (lead.phones || []).filter((p) => p && p !== lead.phone);
  const extras = [];
  for (const email of lead.emails || []) {
    const e = normEmail(email);
    if (!e || seenEmail.has(e)) continue;
    seenEmail.add(e);
    const role = ROLE_ADDRESS.test(e);
    extras.push({
      prospect_id: prospectId,
      name: null, job_title: null,
      email: e,
      email_status: role ? 'role' : 'low',
      phone: null,
      linkedin_url: null,
      source: 'scrape',
      confidence: role ? 20 : 10,
    });
  }
  // A big site can publish 40 addresses (every branch, every account manager).
  // Storing all of them buries the useful ones in the drawer, so keep the
  // best few: role inboxes first, then the rest in page order.
  extras.sort((a, b) => b.confidence - a.confidence);
  const keep = extras.slice(0, Math.max(0, maxRows - rows.length));
  // pair leftover phones onto the kept rows rather than dropping them
  for (const row of keep) row.phone = extraPhones.shift() || null;
  rows.push(...keep);
  // phones with no email at all still deserve a row
  for (const phone of extraPhones) {
    rows.push({
      prospect_id: prospectId, name: null, job_title: null, email: null,
      email_status: null, phone, linkedin_url: null, source: 'scrape',
      confidence: 5,
    });
  }
  return rows;
}

/** crm_prospects row (+ its best contact) → the record shape run.js expects. */
function toRecord(row, contact = {}) {
  return {
    id: row.dedupe_key,
    prospectId: row.id,
    company: row.company_name || '',
    kind: row.kind || 'customer',
    country: row.country || '',
    geoBucket: row.geo_bucket || '',
    service: row.service || '',
    industry: row.industry || '',
    contactName: contact.name || '',
    title: contact.job_title || '',
    email: contact.email || '',
    emailStatus: contact.email_status || '',
    phone: contact.phone || '',
    linkedin: contact.linkedin_url || '',
    website: row.website || '',
    aiScore: row.ai_score,
    why: row.why || '',
    signal: row.signal || '',
    emirate: row.emirate || '',
    hasDraft: !!row.outreach_subject,
    source: row.source || '',
    status: row.status,
    notes: row.notes || '',
    addedAt: (row.created_at || '').slice(0, 10),
    verifiedAt: (row.verified_at || '').slice(0, 10),
  };
}

/** Every prospect, with its highest-confidence contact folded in. Pages
 * through PostgREST rather than trusting a single unbounded request. */
async function load() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await db.select('crm_prospects', {
      select: '*', order: 'created_at.asc', limit: String(PAGE), offset: String(offset),
    });
    if (!Array.isArray(page)) throw new Error(`crm_prospects: unexpected response ${JSON.stringify(page).slice(0, 200)}`);
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  if (!rows.length) return { leads: [] };

  const contacts = await db.select('crm_prospect_contacts', {
    select: 'prospect_id,name,job_title,email,email_status,phone,linkedin_url,confidence',
    order: 'confidence.desc.nullslast',
  });
  const best = new Map();
  for (const c of Array.isArray(contacts) ? contacts : []) {
    if (!best.has(c.prospect_id)) best.set(c.prospect_id, c);   // ordered: first wins
  }
  return { leads: rows.map((r) => toRecord(r, best.get(r.id) || {})) };
}

/** Insert leads that aren't already known, plus their contacts. Duplicates on
 * dedupe_key are ignored by Postgres, so a concurrent cycle can't double-add.
 * Returns the number of prospects actually inserted. */
async function upsertLeads(leads) {
  if (!leads || !leads.length) return 0;

  // collapse repeats inside this batch so PostgREST doesn't reject the payload
  // with "ON CONFLICT DO UPDATE command cannot affect row a second time"
  const byKey = new Map();
  for (const l of leads) if (!byKey.has(idOf(l))) byKey.set(idOf(l), l);
  const unique = [...byKey.values()];

  const inserted = await db.insert('crm_prospects', unique.map(toProspectRow), {
    onConflict: 'dedupe_key', ignoreDuplicates: true,
  });
  if (!Array.isArray(inserted) || !inserted.length) return 0;

  const contactRows = [];
  for (const row of inserted) {
    const lead = byKey.get(row.dedupe_key);
    if (lead) contactRows.push(...toContactRows(lead, row.id));
  }
  if (contactRows.length) {
    // migration 015: one row per (prospect, lower(email)) — let Postgres drop
    // a repeat rather than stacking the same address on a re-harvest
    try {
      await db.insert('crm_prospect_contacts', contactRows, {
        onConflict: 'prospect_id,email', ignoreDuplicates: true,
      });
    } catch (e) { console.warn(`  [store] contacts insert failed: ${e.message}`); }
  }
  return inserted.length;
}

const SALES_FIELDS = ['status', 'notes', 'outreach_subject', 'outreach_body',
  'touch_call', 'touch_mail', 'touch_msg', 'touch_li', 'touch_follow'];
const ENRICHMENT_FIELDS = ['website', 'domain', 'industry', 'emirate', 'country',
  'geo_bucket', 'service', 'ai_score', 'why', 'signal', 'enrichment_status',
  'gap_score', 'talking_points', 'verified_at', 'last_seen_at'];

function pick(fields, allowed) {
  const out = {};
  for (const k of allowed) {
    if (fields && Object.prototype.hasOwnProperty.call(fields, k)) out[k] = fields[k];
  }
  return out;
}

async function applyFields(dedupeKey, fields, allowed) {
  const patch = pick(fields, allowed);
  if (!Object.keys(patch).length) return false;
  const rows = await db.update('crm_prospects', { dedupe_key: `eq.${dedupeKey}` }, patch);
  return Array.isArray(rows) && rows.length > 0;
}

/** Sales-owned columns. The pipeline never calls this; it exists so the
 * allowlist pair stays visible in one place. */
const updateSales = (id, fields) => applyFields(id, fields, SALES_FIELDS);

/** Pipeline refresh-pass mutation: enrichment columns only, never status/notes. */
const updateEnrichment = (id, fields) => applyFields(id, fields, ENRICHMENT_FIELDS);

/** Fill a prospect's cold-email draft — ONLY where none exists yet. The
 * outreach columns are sales-owned (like status/notes), so the pipeline is
 * allowed exactly one write: the initial draft. The IS NULL filter makes
 * that rule hold even against concurrent cycles; once anything is in the
 * column (AI draft or human edit) this becomes a no-op. */
async function setOutreachDraft(dedupeKey, subject, body) {
  if (!dedupeKey || !subject || !body) return false;
  try {
    const rows = await db.update('crm_prospects',
      { dedupe_key: `eq.${dedupeKey}`, outreach_subject: 'is.null' },
      { outreach_subject: subject, outreach_body: body });
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.warn(`  [store] draft update failed: ${e.message}`);
    return false;
  }
}

/** Record a re-verification verdict on the contact row itself. Without this
 * the refresh pass could stamp the prospect's verified_at while the contact
 * kept its stale 'verified' badge — sales would mail a known-dead address,
 * and pickRefreshables would re-spend a match credit on it every cycle
 * (an 'invalid' email_status is what excludes a row from re-verification). */
async function setContactStatus(prospectId, email, pipelineStatus) {
  const mapped = EMAIL_STATUS[pipelineStatus];
  if (!mapped || !prospectId || !email) return false;
  try {
    const rows = await db.update('crm_prospect_contacts',
      { prospect_id: `eq.${prospectId}`, email: `eq.${email}` },
      { email_status: mapped });
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.warn(`  [store] contact status update failed: ${e.message}`);
    return false;
  }
}

/** Replace a prospect's contact row set (used by the refresh pass when Hunter
 * finally finds a named person for a company we only had a role address for). */
async function replaceContact(prospectId, lead) {
  const row = toContactRow(lead, prospectId);
  if (!row) return false;
  try {
    await db.insert('crm_prospect_contacts', [row]);
    return true;
  } catch (e) {
    console.warn(`  [store] contact insert failed: ${e.message}`);
    return false;
  }
}

module.exports = {
  load, upsertLeads, updateSales, updateEnrichment, replaceContact,
  setContactStatus, setOutreachDraft, idOf,
  // exported for tests
  toProspectRow, toContactRow, toContactRows, toRecord, contactEmailStatus,
  contactSource, emirateOf, SALES_FIELDS, ENRICHMENT_FIELDS,
};
