'use strict';
/*
 * mx.js — the free deliverability floor. A domain with no mail route cannot
 * receive anything: no MX record and no A/AAAA fallback (RFC 5321 implicit
 * MX), or an RFC 7505 null MX, means every address behind it is dead. On a
 * bulk-imported list years old this catches whole companies that have folded
 * — before a single message is sent through Brevo and counted as a bounce
 * against our sender reputation.
 *
 * Verdicts are deliberately asymmetric:
 *   'dead'    → definitive negative: contacts on the domain get
 *               email_status 'invalid' (same terminal state a bounce earns).
 *   'ok'      → the domain ACCEPTS mail; it says nothing about the mailbox,
 *               so no status is ever upgraded on the strength of it.
 *   'unknown' → DNS trouble (timeout, SERVFAIL). Never written anywhere:
 *               resolver hiccups must not brand a live company dead.
 *
 * sweep() is the whole pass: page contacts → distinct domains due a check
 * (file cache, recheckDays) → resolve with bounded concurrency → mark
 * contacts on dead domains. run.js calls it capped per cycle; the one-off
 * verify-mx-sweep.js calls it uncapped for the backlog.
 */
const fs = require('fs');
const dns = require('dns');

const PAGE = 1000;

/** true only for the RFC 7505 "this domain refuses mail" record: `0 .` */
function isNullMx(records) {
  return records.length === 1 &&
    ['', '.'].includes(String(records[0].exchange || '').trim());
}

const NEGATIVE = ['ENOTFOUND', 'ENODATA'];   // NXDOMAIN / empty answer

/** Build the verdict function around a resolver (injectable for tests). */
function createChecker(resolver) {
  const r = resolver || new dns.promises.Resolver({ timeout: 5000, tries: 2 });
  return async function verdictOf(domain) {
    try {
      const mx = await r.resolveMx(domain);
      if (!mx.length) throw Object.assign(new Error('empty'), { code: 'ENODATA' });
      return isNullMx(mx) ? 'dead' : 'ok';
    } catch (e) {
      if (e.code === 'ENOTFOUND') return 'dead';        // domain itself is gone
      if (e.code !== 'ENODATA') return 'unknown';       // resolver trouble
    }
    // domain exists but has no MX — implicit-MX fallback to A/AAAA
    for (const resolve of [r.resolve4.bind(r), r.resolve6.bind(r)]) {
      try {
        if ((await resolve(domain)).length) return 'ok';
      } catch (e) {
        if (!NEGATIVE.includes(e.code)) return 'unknown';
      }
    }
    return 'dead';
  };
}

/** Distinct email domains that are due a check: not cached within
 * recheckDays. Pure; order = first appearance. */
function pickDomains(emails, cache, { recheckDays, today }) {
  const cutoff = new Date(new Date(today) - recheckDays * 86400000)
    .toISOString().slice(0, 10);
  const out = [];
  const seen = new Set();
  for (const email of emails) {
    const domain = String(email || '').toLowerCase().split('@')[1];
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    const hit = cache[domain];
    if (hit && hit.at >= cutoff) continue;
    out.push(domain);
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Every contact email that is not already known-invalid. */
async function loadEmails(db) {
  const emails = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await db.select('crm_prospect_contacts', {
      select: 'email',
      email: 'not.is.null',
      or: NOT_INVALID,
      order: 'id.asc',
      limit: String(PAGE),
      offset: String(offset),
    });
    if (!Array.isArray(page)) throw new Error(`contacts: unexpected response ${JSON.stringify(page).slice(0, 200)}`);
    emails.push(...page.map((r) => r.email));
    if (page.length < PAGE) break;
  }
  return emails;
}

// The one status filter, shared by the count and the PATCH below.
const NOT_INVALID = '(email_status.neq.invalid,email_status.is.null)';

/** email_status := 'invalid' for every non-invalid contact on the domain.
 * Returns rows touched. LIKE is safe here: a hostname can contain no '%'
 * or '_', so the only wildcard in the pattern is the one we put there.
 *
 * Counted with a SELECT first, not from the PATCH representation: PostgREST
 * applies an `or` filter to the update AND to the rows it echoes back —
 * re-evaluated against the NEW values, so a row this call just flipped to
 * 'invalid' no longer matches and vanishes from the response. The first
 * backlog sweep invalidated 82 contacts while reporting 0 this way. */
async function invalidateDomain(db, domain) {
  const match = { email: `like.*@${domain}`, or: NOT_INVALID };
  const rows = await db.select('crm_prospect_contacts', { select: 'id', ...match });
  const due = Array.isArray(rows) ? rows.length : 0;
  if (!due) return 0;
  await db.update('crm_prospect_contacts', match, { email_status: 'invalid' });
  return due;
}

function loadCache(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return {}; }
}

/**
 * The full pass. deps/opts:
 *   db          — lib/supabase (select/update)         [required]
 *   cachePath   — state file for per-domain verdicts   [required]
 *   maxDomains  — cap on domains checked this call (Infinity = backlog sweep)
 *   recheckDays — how long an 'ok'/'dead' verdict stays fresh
 *   concurrency — parallel DNS lookups
 *   resolver    — injectable for tests
 *   today       — ISO date, injectable for tests
 * Returns { due, checked, dead, unknown, invalidated }.
 */
async function sweep({ db, cachePath, maxDomains = 150, recheckDays = 60,
                       concurrency = 10, resolver, today } = {}) {
  const cache = loadCache(cachePath);
  const emails = await loadEmails(db);
  const due = pickDomains(emails, cache, {
    recheckDays, today: today || new Date().toISOString().slice(0, 10),
  });
  const batch = due.slice(0, maxDomains);
  const verdictOf = createChecker(resolver);
  const stats = { due: due.length, checked: batch.length, dead: 0, unknown: 0, invalidated: 0 };

  const verdicts = await mapLimit(batch, concurrency, verdictOf);
  for (let i = 0; i < batch.length; i++) {
    const domain = batch[i], v = verdicts[i];
    if (v === 'unknown') { stats.unknown++; continue; }   // not cached: retried next pass
    cache[domain] = { v, at: (today || new Date().toISOString().slice(0, 10)) };
    if (v === 'dead') {
      stats.dead++;
      stats.invalidated += await invalidateDomain(db, domain);
    }
  }
  if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(cache));
  return stats;
}

module.exports = { sweep, createChecker, pickDomains, isNullMx, invalidateDomain, mapLimit };
