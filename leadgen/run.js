'use strict';
/*
 * run.js — orchestrator for the Underwings lead machine.
 *   gather (6 UAE sources) → dedupe → Claude score vs ICP → website discovery
 *   → contact harvest (scrape → Apollo person + reveal) → upsert into
 *   crm_prospects → refresh pass.
 *
 * One-shot:    node run.js
 * Dry run:     node run.js --dry         (prints records; no writes, no refresh)
 * Continuous:  node run.js --loop        (every config.intervalMinutes, and
 *                                         polls crm_leadgen_settings for a
 *                                         "run now" request in between)
 *
 * Env: ANTHROPIC_API_KEY, SERVICE_ROLE_KEY, SUPABASE_URL (default
 *      http://kong:8000), optional APOLLO_API_KEY, FIRECRAWL_API_KEY,
 *      GOOGLE_PLACES_API_KEY, KUMA_PUSH_URL.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const sources = require('./sources');
const { enrich } = require('./lib/enrich');
const outreach = require('./lib/outreach');
const { harvestContacts } = require('./lib/contacts');
const apollo = require('./lib/apollo');
const budget = require('./lib/budget');
const { findWebsite } = require('./lib/website-finder');
const { domainOf, normCompany } = require('./lib/parse');
const D = require('./lib/dates');
const store = require('./lib/store-pg');
const db = require('./lib/supabase');
const { sleep } = require('./lib/http');

const SEEN_PATH = path.join(__dirname, 'state', 'seen.json');
const CYCLE_PATH = path.join(__dirname, 'state', 'cycle.json');

// legal-suffix-aware, shared with store-pg so the key we dedupe on is the
// key we write (lib/parse.normCompany)
const norm = normCompany;
const keyOf = (c) => (c.domain ? `d:${c.domain}` : `c:${norm(c.company)}`);

/** Both dedupe keys a candidate can be known by. */
function keysOf(c) {
  const ks = [];
  if (c.domain) ks.push(`d:${c.domain}`);
  if (c.company) ks.push(`c:${norm(c.company)}`);
  return ks;
}

/** Drop candidates already known — by EITHER key — in `seenSet` (read-only)
 * or earlier in this same batch. Pure; exported. */
function dedupeCandidates(candidates, seenSet) {
  const batchSeen = new Set();
  return candidates.filter((c) => {
    const ks = keysOf(c);
    if (ks.some((k) => seenSet.has(k) || batchSeen.has(k))) return false;
    for (const k of ks) batchSeen.add(k);
    return true;
  });
}

/** Round-robin across sources so the per-run cap can't starve any source. */
function interleave(bySource) {
  const lists = Object.values(bySource).filter((l) => l && l.length);
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'))); }
  catch { return new Set(); }
}
function saveSeen(set) {
  // crm_prospects is append-forever, so seen is NEVER cleared on month
  // rollover — the old sheet pipeline did that, and with a persistent store it
  // would re-discover and re-score (re-bill) every company every month.
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...set].slice(-20000)));
}

/** Persistent cycle counter drives source rotation (overpass/websearch/
 * exhibitors/places). persist=false (dry runs) reads but never advances it. */
function nextCycle(persist = true) {
  let n = 0;
  try { n = JSON.parse(fs.readFileSync(CYCLE_PATH, 'utf8')).cycle || 0; } catch { /* */ }
  if (persist) {
    try { fs.writeFileSync(CYCLE_PATH, JSON.stringify({ cycle: n + 1 })); } catch { /* */ }
  }
  return n;
}

/** Enrichment waterfall per kept lead. Mutates leads. Budget-capped. */
async function harvestAll(leads, env) {
  const apolloKey = env.APOLLO_API_KEY;
  const fcKey = env.FIRECRAWL_API_KEY;
  let withEmail = 0, withPerson = 0;
  for (const l of leads) {
    // 0. news/search leads often arrive name-only — find the official site
    if (!l.website && fcKey &&
        budget.remaining('firecrawl', cfg.firecrawl.monthlyCap) > 0) {
      budget.spend('firecrawl', 3);   // findWebsite requests limit 3
      l.website = await findWebsite(l.company, fcKey);
      l.domain = domainOf(l.website);
    }
    // 1. free website scrape → role email + phone. EVERY address and phone is
    //    kept (store-pg writes one contact row each): sales work a company by
    //    trying several inboxes, so the extras are the point, not noise.
    if (l.website) {
      try {
        const c = await harvestContacts(l.website, l.phone);
        if (c.best && !l.email) { l.email = c.best; l.emailStatus = 'unverified'; }
        if (c.phones.length && !l.phone) l.phone = c.phones[0];
        l.emails = c.emails || [];
        l.phones = c.phones || [];
      } catch { /* best effort */ }
    }
    // 1.5 Apollo firmographics (the one endpoint every plan tier allows):
    //     industry, headcount band, location — fills CRM columns the sources
    //     rarely carry. Never overwrites what Claude already classified.
    //     Gated on the credit latch too: once Apollo reports an empty balance
    //     every further call 422s, and spend-before-call would burn the
    //     monthly counter on guaranteed failures.
    if (apolloKey && l.domain && !apollo.orgCreditsBlocked() &&
        budget.remaining('apollo-org', cfg.apollo.orgCap) > 0) {
      budget.spend('apollo-org', 1);
      const org = await apollo.enrichOrg(l.domain, apolloKey);
      if (org) {
        if (!l.industry && org.industry) l.industry = org.industry;
        l.sizeBand = apollo.sizeBandOf(org.employees);
        if (!l.country && org.country) l.country = org.country;
        if (!l.location) l.location = [org.city, org.country].filter(Boolean).join(', ');
      }
    }
    // 2. Apollo → named person; person email wins over role email. Search and
    //    reveal are budgeted separately so a search that finds no one never
    //    burns an email credit. Apollo emails arrive with their own
    //    verification status, so there is no step 3 — scraped-only emails
    //    stay 'unverified' and store-pg maps them to role/low.
    //    NB: 403 API_INACCESSIBLE on the Free plan — findPerson logs it and
    //    returns null until the plan is upgraded.
    //    Match headroom is required UP FRONT: search responses carry no email
    //    (only has_email), so a search with no reveal credit left is a
    //    guaranteed no-op that would still burn the counter + a rate slot.
    if (apolloKey && l.domain && !apollo.planBlocked() &&
        budget.remaining('apollo-search', cfg.apollo.searchCap) > 0 &&
        budget.remaining('apollo-match', cfg.apollo.matchCap) > 0) {
      budget.spend('apollo-search', 1);
      const person = await apollo.findPerson(l.domain, apolloKey);
      // normalize() is a free guard: current search responses never carry an
      // email, so the reveal below is the normal path
      let p = apollo.normalize(person);
      if (person && !p &&
          budget.remaining('apollo-match', cfg.apollo.matchCap) > 0) {
        budget.spend('apollo-match', 1);
        p = await apollo.reveal(person, apolloKey);
      }
      if (p && p.email) {
        l.contactName = p.name;
        l.title = p.title || '';
        l.email = p.email;
        l.emailStatus = p.status;
        l.confidence = p.confidence || null;
        if (p.linkedin) l.linkedin = p.linkedin;
        if (p.name) withPerson++;
      }
    }
    if (l.email) withEmail++;
  }
  console.log(`Harvested: ${withEmail}/${leads.length} emails (${withPerson} named contacts)`);
  return leads;
}

/** Split scored leads into the two tracks and apply each one's rule. Pure;
 * exported. Customers are unbounded above the score threshold — they are the
 * business. Partners are a deliberately SMALL, high-quality trickle
 * (cfg.partners.perCycle, ~10/day over two cycles): a partner lead is worth
 * something only if someone actually has the collaboration conversation, and
 * a flood of them would bury the customer pipeline in the same table. */
function selectLeads(scored, {
  threshold = cfg.scoreThreshold,
  partnerThreshold = cfg.partners.scoreThreshold,
  partnerCap = cfg.partners.perCycle,
} = {}) {
  const byScore = (a, b) => (b.icp_score || 0) - (a.icp_score || 0);
  const customers = scored
    .filter((l) => l.kind !== 'partner' && (l.icp_score || 0) >= threshold)
    .sort(byScore);
  const partners = scored
    .filter((l) => l.kind === 'partner' && (l.icp_score || 0) >= partnerThreshold)
    .sort(byScore)
    .slice(0, partnerCap);
  return [...customers, ...partners];
}

/** Decide refresh work from store records. Pure; exported.
 * Returns {reverify:[...], recontact:[...]}, total capped at maxRows.
 * Records with email status 'invalid' are left alone (flagged, never deleted);
 * status/notes are never part of refresh. */
function pickRefreshables(records, { reverifyAfterDays, maxRows, today }) {
  const reverify = [], recontact = [];
  for (const r of records) {
    if (reverify.length + recontact.length >= maxRows) break;
    const last = r.verifiedAt || r.addedAt;
    const stale = D.daysSince(last, today) >= reverifyAfterDays;
    if (r.email && ['verified', 'probable', 'low', 'role'].includes(r.emailStatus) && stale) {
      reverify.push({ id: r.id, prospectId: r.prospectId, email: r.email, addedAt: r.addedAt, verifiedAt: r.verifiedAt });
    } else if (!r.contactName && r.website && stale) {
      recontact.push({ id: r.id, prospectId: r.prospectId, domain: domainOf(r.website), addedAt: r.addedAt });
    }
  }
  return { reverify, recontact };
}

/** The "keep updated" pass: re-verify stale emails, retry missing contacts. */
async function refreshExisting(env, db_) {
  const apolloKey = env.APOLLO_API_KEY;
  if (!apolloKey) { console.log('Refresh: skipped — no APOLLO_API_KEY'); return; }
  if (apollo.planBlocked()) {
    console.log('Refresh: skipped — Apollo people endpoints not in this plan'); return;
  }
  if (budget.remaining('apollo-match', cfg.apollo.matchCap) <= 0 &&
      budget.remaining('apollo-search', cfg.apollo.searchCap) <= 0) {
    console.log('Refresh: skipped — Apollo budget exhausted'); return;
  }
  const records = db_ ? db_.leads : (await store.load()).leads;
  const { reverify, recontact } = pickRefreshables(records, {
    reverifyAfterDays: cfg.refresh.reverifyAfterDays,
    maxRows: cfg.refresh.maxRowsPerCycle,
    today: D.today(),
  });
  let updated = 0;
  for (const { id, prospectId, email } of reverify) {
    if (apollo.planBlocked()) break;   // latch tripped mid-loop — stop spending
    if (budget.remaining('apollo-match', cfg.apollo.matchCap) <= 0) break;
    budget.spend('apollo-match', 1);
    const status = await apollo.enrichByEmail(email, apolloKey);
    if (status === 'unverified') continue;   // API failed / no data — don't rewrite state
    // The verdict must land on the CONTACT row: verified_at alone would leave
    // a bounced address wearing its old 'verified' badge, and only an
    // 'invalid' email_status stops pickRefreshables re-spending on it.
    await store.setContactStatus(prospectId, email, status);
    await store.updateEnrichment(id, {
      verified_at: new Date().toISOString(),
      enrichment_status: 'enriched',
    });
    updated++;
  }
  for (const { prospectId, domain } of recontact) {
    if (apollo.planBlocked()) break;
    // as in harvestAll: no reveal headroom ⇒ a search cannot yield an email
    if (budget.remaining('apollo-search', cfg.apollo.searchCap) <= 0 ||
        budget.remaining('apollo-match', cfg.apollo.matchCap) <= 0) break;
    budget.spend('apollo-search', 1);
    const person = await apollo.findPerson(domain, apolloKey);
    let p = apollo.normalize(person);
    if (person && !p && budget.remaining('apollo-match', cfg.apollo.matchCap) > 0) {
      budget.spend('apollo-match', 1);
      p = await apollo.reveal(person, apolloKey);
    }
    if (!p || !p.email) continue;
    await store.replaceContact(prospectId, {
      contactName: p.name || '', title: p.title || '', email: p.email,
      emailStatus: p.status, linkedin: p.linkedin || '', confidence: p.confidence,
    });
    updated++;
  }
  console.log(`Refresh: ${reverify.length} re-verified, ${recontact.length} contact retries, ${updated} records updated`);
}

/** Draft cold emails for existing prospects that don't have one — rows from
 * before the feature, plus any whose draft batch failed at insert time.
 * setOutreachDraft's IS NULL filter guarantees nothing existing (AI draft or
 * a human edit, even one cleared to '') is ever overwritten. Capped per
 * cycle to bound Claude spend. */
async function backfillOutreach(apiKey, db_) {
  const missing = (db_.leads || [])
    .filter((r) => !r.hasDraft && r.company)
    .slice(0, cfg.outreach.backfillPerCycle);
  if (!missing.length) return;
  const drafted = await outreach.draftAll(apiKey, missing);
  let written = 0;
  for (const r of missing) {
    if (!r.outreachSubject) continue;
    if (await store.setOutreachDraft(r.id, r.outreachSubject, r.outreachBody)) written++;
  }
  console.log(`Outreach backfill: ${drafted} drafted, ${written} written (${missing.length} candidates)`);
}

/** Open a crm_leadgen_runs row. Best-effort: a logging failure must not stop
 * the cycle, so this returns null and every later call no-ops. */
async function startRun(cycle, triggeredBy) {
  try {
    const rows = await db.insert('crm_leadgen_runs',
      [{ cycle, triggered_by: triggeredBy }]);
    return Array.isArray(rows) && rows[0] ? rows[0].id : null;
  } catch (e) { console.warn(`  [runs] could not open run row: ${e.message}`); return null; }
}
async function finishRun(id, fields) {
  if (!id) return;
  try { await db.update('crm_leadgen_runs', { id: `eq.${id}` }, { finished_at: new Date().toISOString(), ...fields }); }
  catch (e) { console.warn(`  [runs] could not close run row: ${e.message}`); }
}

async function runOnce(opts = {}) {
  const t0 = Date.now();
  console.log(`\n=== underwings leadgen run @ ${new Date().toISOString()}${opts.dry ? ' (DRY)' : ''} ===`);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  await budget.sync();

  // Dedupe seeds: below-threshold companies cached across cycles (seen.json)
  // plus every prospect already in the CRM — both keysOf() forms and its
  // dedupe_key. load() throws on a transport error rather than silently
  // returning an empty store, which would re-score everything we already have.
  const seen = loadSeen();
  const existing = await store.load();
  // Kept separate from `seen`: `seen` accumulates this cycle's candidates as
  // they are scored, so it cannot be reused for the post-scoring dedupe pass
  // below — every lead would match itself.
  const storeKeys = new Set();
  for (const rec of existing.leads) {
    for (const k of keysOf({ company: rec.company, domain: domainOf(rec.website) })) {
      seen.add(k); storeKeys.add(k);
    }
    seen.add(rec.id); storeKeys.add(rec.id);
  }

  const cycle = nextCycle(!opts.dry);
  const runId = opts.dry ? null : await startRun(cycle, opts.triggeredBy || 'schedule');

  try {
    console.log(`Gathering from sources (cycle ${cycle})…`);
    const bySource = await sources.gatherAll(process.env, cycle);
    let candidates = interleave(bySource);
    candidates = candidates.filter((c) => c.company || c.signal);
    candidates = dedupeCandidates(candidates, seen);
    console.log(`Deduped → ${candidates.length} new candidates`);
    candidates = candidates.slice(0, cfg.maxCandidatesPerRun);

    console.log(`Scoring ${candidates.length} with Claude (${cfg.claudeModel})…`);
    const { leads: scored, assessed, failedBatches } = await enrich(apiKey, candidates);
    // Only candidates Claude actually assessed are remembered. A batch lost to
    // a transient API error is left OUT of seen so it is retried next cycle,
    // instead of being blacklisted forever.
    for (const c of assessed) for (const k of keysOf(c)) seen.add(k);
    for (const l of scored) for (const k of keysOf(l)) seen.add(k);
    if (failedBatches) {
      console.warn(`  ${failedBatches} Claude batch(es) failed — those candidates will be retried next cycle`);
    }

    // Second dedupe, now that every lead HAS a name. A news candidate arrives
    // as a bare signal with company:'' — the pre-scoring pass can only match
    // it on a domain it doesn't have, so the same company surfaced by the
    // news and by a directory became two prospects (Property Finder, Gulf
    // Business Machines, Wio Bank all landed twice this way).
    const named = dedupeCandidates(scored, storeKeys);
    if (named.length < scored.length) {
      console.log(`  ${scored.length - named.length} already-known company/companies dropped after naming`);
    }
    // (their keys are already in `seen` from the `scored` loop above)

    const leads = selectLeads(named);
    const nPartners = leads.filter((l) => l.kind === 'partner').length;
    console.log(`Claude kept ${scored.length}; taking ${leads.length} ` +
      `(${leads.length - nPartners} customers ≥ threshold ${cfg.scoreThreshold}, ` +
      `${nPartners} partners ≥ ${cfg.partners.scoreThreshold})`);

    if (!leads.length) {
      if (!opts.dry) {
        saveSeen(seen);
        await refreshExisting(process.env, existing);
        await backfillOutreach(apiKey, existing);
        await budget.flush();
        await finishRun(runId, { ok: true, candidates: candidates.length, scored: scored.length, kept: 0, added: 0 });
      }
      console.log('No leads to write this cycle.');
      return 0;
    }

    // enrich contacts (top scores first — budget lands on the best)
    console.log('Harvesting contacts (scrape → Apollo)…');
    await harvestAll(leads, process.env);

    // Draft the cold email AFTER contact harvest so the greeting can address
    // the named person. A failed batch leaves those leads draft-less and the
    // backfill pass retries them next cycle.
    console.log('Drafting cold emails…');
    const drafted = await outreach.draftAll(apiKey, leads);
    console.log(`  ${drafted}/${leads.length} drafts written`);

    if (opts.dry) {
      console.log(`--dry: would add ${leads.length} prospects:`);
      for (const l of leads) {
        console.log(`  ${l.company} | ${l.country || '-'} | ${l.service || '-'} | score ${l.icp_score} | ${l.contactName || '(no contact)'} | ${l.email || '(no email)'} (${l.emailStatus || '-'})`);
      }
      console.log('(dry run: seen.json not saved, nothing written, no refresh pass; paid budgets WERE spent)');
      await budget.flush();
      return leads.length;
    }

    const added = await store.upsertLeads(leads);
    saveSeen(seen);
    console.log(`✅ Added ${added}/${leads.length} prospects to the CRM (${Date.now() - t0}ms)`);
    await refreshExisting(process.env, existing);
    await backfillOutreach(apiKey, existing);
    await budget.flush();
    await finishRun(runId, {
      ok: true, candidates: candidates.length, scored: scored.length,
      kept: leads.length, added,
    });
    return added;
  } catch (e) {
    await budget.flush().catch(() => {});
    await finishRun(runId, { ok: false, errors: [String(e.message || e)] });
    throw e;
  }
}

/** Ping Uptime Kuma after a successful cycle (no-op unless KUMA_PUSH_URL set). */
async function heartbeat(n) {
  const url = process.env.KUMA_PUSH_URL;
  if (!url) return;
  try {
    const sep = url.includes('?') ? '&' : '?';
    await fetch(`${url}${sep}status=up&msg=${encodeURIComponent(`wrote ${n} prospects`)}`,
      { signal: AbortSignal.timeout(10000) });
  } catch { /* monitoring is best-effort */ }
}

/** Has an admin asked for a cycle from the CRM since `since`? The browser
 * cannot reach this container (CSP connect-src 'self', and no route exists),
 * so "run now" is a flag in crm_leadgen_settings that we poll. */
async function runRequestedSince(since) {
  try {
    const rows = await db.select('crm_leadgen_settings', { select: 'run_requested_at', limit: '1' });
    const at = Array.isArray(rows) && rows[0] && rows[0].run_requested_at;
    if (!at) return null;
    return new Date(at) > since ? new Date(at) : null;
  } catch (e) {
    console.warn(`  [run-now] poll failed: ${e.message}`);
    return null;
  }
}

/** Sleep for `ms`, waking early if a manual run is requested.
 * @returns 'manual' if a run was requested, else 'schedule'. */
async function waitForNextCycle(ms) {
  const deadline = Date.now() + ms;
  let watermark = new Date();
  const pollMs = Math.max(15, cfg.runNowPollSeconds) * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollMs, deadline - Date.now()));
    const requested = await runRequestedSince(watermark);
    if (requested) {
      watermark = requested;
      console.log(`Manual run requested at ${requested.toISOString()} — starting now`);
      return 'manual';
    }
  }
  return 'schedule';
}

async function main() {
  const dry = process.argv.includes('--dry');
  const loop = process.argv.includes('--loop');
  if (dry && loop) {
    console.error('--dry cannot be combined with --loop');
    process.exit(1);
  }
  if (!loop) { await runOnce({ dry }); return; }
  console.log(`Continuous mode — every ${cfg.intervalMinutes} min ` +
              `(polling for manual runs every ${cfg.runNowPollSeconds}s)`);
  let triggeredBy = 'schedule';
  for (;;) {
    try { const n = await runOnce({ triggeredBy }); await heartbeat(n); }
    catch (e) { console.error('run failed:', e.message); }
    triggeredBy = await waitForNextCycle(cfg.intervalMinutes * 60 * 1000);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = {
  keyOf, keysOf, dedupeCandidates, norm, pickRefreshables, interleave,
  runRequestedSince, harvestAll, selectLeads,
};
