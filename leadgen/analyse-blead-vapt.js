'use strict';
/*
 * analyse-blead-vapt.js — mine the BLead list for VAPT buyers and MOVE them.
 *
 * 5,009 of the 6,474 imported blead rows carry no industry label, and the
 * labels that exist are mostly construction/environmental — so a regex alone
 * cannot find the software-operating companies hiding in the list. Two tiers:
 *
 *   Tier 1 — deterministic: unambiguous tech industry labels move on sight.
 *   Tier 2 — Claude (Haiku, 40 rows/batch): name + domain + industry
 *            one-liners, conservative yes/no per row.
 *
 * A match is RE-KINDED in place (kind='vapt', service stamped): dedupe_key is
 * unique, so a company cannot live in two tabs — moving keeps one row, one
 * owner, one outreach history. Notes, ticks and contacts ride along untouched.
 *
 * Provenance rule stands: this reads DB rows only — the scrubbed CSV columns
 * are never re-read, and the QRS/TQS/GCEE audit must stay 0 afterwards.
 *
 *   docker exec underwings-leadgen node analyse-blead-vapt.js --dry-run
 *   docker exec underwings-leadgen node analyse-blead-vapt.js
 *
 * After a live move, rows lacking any phone get a Google Places lookup
 * (domain/name-verified, source='places'), bounded by the shared monthly cap.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./lib/supabase');
const budget = require('./lib/budget');
const { request, getJson, sleep } = require('./lib/http');
const { domainOf, normCompany } = require('./lib/parse');

const DRY = process.argv.includes('--dry-run');
const BATCH = 40;
const SERVICE = 'PTaaS / Pen Testing';
const REPORT = path.join(__dirname, 'state', 'blead-vapt-analysis.json');
const PLACES_FLOOR = 500;

// There is deliberately NO deterministic "obviously tech → move" fast path:
// the first dry-runs proved the imported lists carry foreign vendors WITH
// clean tech labels (Cognizant, WeTransfer, Attio, an oraclecloud.com
// subdomain), so an industry label alone must never bypass the UAE/vendor
// rules. Everything goes through Claude; determinism is used only to EXCLUDE.

// Global vendors observed in these lists — companies that SELL software at a
// scale no five-person UAE consultancy sells pen tests to. Matched on the
// registrable domain, so subdomains (ocs.oraclecloud.com) are caught too.
const VENDOR_DOMAINS = [
  'sap.com', 'ariba.com', 'oracle.com', 'oraclecloud.com', 'samsung.com',
  'openai.com', 'anthropic.com', 'lusha.com', 'gep.com', 'cognizant.com',
  'wetransfer.com', 'attio.com', 'zoho.com', 'zohocdn.com', 'microsoft.com',
  'google.com', 'amazon.com', 'aws.amazon.com', 'salesforce.com', 'adobe.com',
  'birchstreet.net', 'crif.com',
];
function isVendorDomain(domain) {
  const d = String(domain || '').toLowerCase();
  return VENDOR_DOMAINS.some((v) => d === v || d.endsWith('.' + v));
}

// A foreign ccTLD is strong negative evidence — the imported lists carry
// vendors and counterparties from Oman, Qatar, Pakistan, the UK etc. that a
// UAE pen-test campaign cannot sell to. (.io/.ai/.me stay: UAE startups use
// them.) Applied BEFORE both tiers, so a foreign row never reaches Claude
// and can never tier-1 its way in on an industry label.
const FOREIGN_TLD =
  /\.(om|qa|sa|kw|bh|eg|jo|lb|pk|in|lk|uk|us|de|fr|es|it|nl|ch|se|tr|ru|cn|jp|kr|sg|hk|my|id|th|au|nz|ca|br|mx|za|ng|ke)$|\.co\.uk$|\.(com|net|org|gov|edu)\.(om|qa|sa|kw|bh|eg|pk|in|au|my|sg|tr)$/i;
// Anything with these anywhere is at least worth asking Claude about even
// when the label leads with something else ("Environmental … / Software").
const TIER2_HINT = /software|saas|fintech|e-?comm|payment|app|digital|technology|it\b|data|platform|online|web|cyber|telecom/i;

const TOOL = {
  name: 'record_classification',
  description: 'Record whether each company is a plausible VAPT (penetration-testing) buyer.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            vapt_relevant: { type: 'boolean', description: 'true ONLY when the company clearly operates software: a tech/software/fintech/e-commerce/app business' },
            reason: { type: 'string', description: 'one short line' },
          },
          required: ['index', 'vapt_relevant', 'reason'],
        },
      },
    },
    required: ['items'],
  },
};

function classifyPrompt(batch) {
  const lines = batch.map((r, i) =>
    `[${i}] ${r.company_name} | ${r.domain || '-'} | ${r.industry || '-'}`).join('\n');
  return (
    `You are triaging a bulk list of companies for a UAE penetration-testing ` +
    `sales campaign run by a five-person consultancy. For each line ` +
    `(company | domain | industry), decide if the company is a SELLABLE ` +
    `VAPT TARGET: a UAE-based SME or mid-market business that OPERATES ` +
    `CUSTOMER-FACING SOFTWARE — software / SaaS / fintech / payments / ` +
    `e-commerce / app / online-platform businesses, or IT companies shipping ` +
    `products. These buy penetration tests from small firms.\n` +
    `FALSE for all of these, no matter how technical they are:\n` +
    `- Global technology vendors and platforms (SAP, Oracle, Samsung, ` +
    `OpenAI scale) — they SELL software; a five-person UAE consultancy ` +
    `cannot sell pen tests to them.\n` +
    `- Major banks, telecom operators, airlines, government bodies and other ` +
    `1000+ staff enterprises — procurement-gated, out of profile.\n` +
    `- Companies without UAE operations: foreign country domains or a ` +
    `clearly foreign HQ.\n` +
    `BE CONSERVATIVE: construction, environmental consultancy, manufacturing, ` +
    `trading, hospitality and generic services are NOT relevant, even when ` +
    `the name contains generic words like "systems", "solutions" or "tech". ` +
    `A bare trading/contracting name with no tech evidence is false. When in ` +
    `doubt: false.\n\n${lines}`
  );
}

async function classify(apiKey, batch) {
  const res = await request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.claudeModel, max_tokens: 4096,
      tools: [TOOL], tool_choice: { type: 'tool', name: 'record_classification' },
      messages: [{ role: 'user', content: classifyPrompt(batch) }],
    }),
  }, { timeoutMs: 60000, retries: 2 });
  const j = await res.json();
  const tu = (j.content || []).find((c) => c.type === 'tool_use');
  return tu?.input?.items || [];
}

async function loadBleads() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await db.select('crm_prospects', {
      select: 'id,dedupe_key,company_name,domain,industry,status',
      kind: 'eq.blead',
      order: 'created_at.asc',
      offset: String(from), limit: '1000',
    });
    if (!Array.isArray(page)) throw new Error('crm_prospects read failed');
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

/** PostgREST `in.(…)` needs each key quoted — dedupe keys carry ':' and '.'. */
function inList(keys) {
  return `in.(${keys.map((k) => `"${k}"`).join(',')})`;
}

async function moveRows(keys) {
  let moved = 0;
  for (let i = 0; i < keys.length; i += 50) {
    const slice = keys.slice(i, i + 50);
    const updated = await db.update('crm_prospects',
      { dedupe_key: inList(slice) },
      { kind: 'vapt', service: SERVICE });
    moved += Array.isArray(updated) ? updated.length : 0;
  }
  return moved;
}

function sameCompany(a, b) {
  const na = normCompany(a), nb = normCompany(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const tokens = (s) => s.split(/\s+/).filter((t) => t.length >= 4);
  const ta = tokens(na), tb = tokens(nb);
  if (!ta.length || !tb.length) return false;
  return ta.every((t) => nb.includes(t)) || tb.every((t) => na.includes(t));
}

/** Places phone lookup for moved rows with no phone on file. */
async function backfillPhones(moved) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) { console.log('Phone backfill: skipped — no GOOGLE_PLACES_API_KEY'); return 0; }
  let added = 0;
  for (const r of moved) {
    if (budget.remaining('google-places', cfg.places.monthlyCap) <= PLACES_FLOOR) {
      console.log('Phone backfill: cap floor reached — stopping'); break;
    }
    const existing = await db.select('crm_prospect_contacts', {
      select: 'id,phone', prospect_id: `eq.${r.id}`, phone: 'not.is.null', limit: '1',
    });
    if (Array.isArray(existing) && existing.length) continue;   // has a phone already
    try {
      budget.spend('google-places', 1);
      const j = await getJson('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.displayName,places.websiteUri,places.nationalPhoneNumber',
        },
        body: JSON.stringify({ textQuery: `${r.company_name} UAE`, maxResultCount: 3 }),
      });
      const hit = (j.places || []).map((p) => ({
        company: p.displayName?.text || '',
        domain: domainOf(p.websiteUri || ''),
        phone: p.nationalPhoneNumber || '',
      })).find((h) => h.phone &&
        ((r.domain && h.domain && h.domain === r.domain) || sameCompany(h.company, r.company_name)));
      if (!hit) continue;
      await db.insert('crm_prospect_contacts', [{
        prospect_id: r.id, phone: hit.phone, source: 'places', confidence: 60,
      }]);
      added += 1;
    } catch (e) { console.warn(`  [places:${r.company_name}] ${e.message}`); }
    await sleep(150);
  }
  return added;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1); }
  await budget.sync();

  const rows = await loadBleads();
  console.log(`BLead rows: ${rows.length}`);

  const matches = [];   // { row, tier, reason }
  const forClaude = [];
  let foreign = 0, vendors = 0;
  for (const r of rows) {
    if (FOREIGN_TLD.test(r.domain || '')) { foreign += 1; continue; }
    if (isVendorDomain(r.domain)) { vendors += 1; continue; }
    forClaude.push(r);
  }
  console.log(`Skipped deterministically: ${foreign} foreign-domain, ${vendors} global-vendor`);
  console.log(`To classify: ${forClaude.length}`);

  let batches = 0;
  for (let i = 0; i < forClaude.length; i += BATCH) {
    const batch = forClaude.slice(i, i + BATCH);
    batches += 1;
    if (batches % 20 === 0) console.log(`  classified ${i}/${forClaude.length}…`);
    try {
      for (const item of await classify(apiKey, batch)) {
        const r = batch[item.index];
        if (r && item.vapt_relevant === true) {
          matches.push({ row: r, tier: 2, reason: item.reason || '' });
        }
      }
    } catch (e) { console.warn(`  [claude] batch at ${i} failed: ${e.message} — rows stay blead`); }
    await sleep(300);
  }

  console.log(`\nTotal VAPT-relevant: ${matches.length} of ${rows.length}`);
  fs.writeFileSync(REPORT, JSON.stringify({
    at: new Date().toISOString(), total: rows.length, matched: matches.length,
    dryRun: DRY,
    matches: matches.map((m) => ({
      company: m.row.company_name, domain: m.row.domain,
      industry: m.row.industry, tier: m.tier, reason: m.reason,
    })),
  }, null, 2));
  console.log(`Report: ${REPORT}`);

  if (DRY) {
    console.log('\n--dry-run: nothing moved. Would move:');
    for (const m of matches) {
      console.log(`  [T${m.tier}] ${m.row.company_name}  ${m.row.domain || '-'}  — ${m.reason}`);
    }
    process.exit(0);
  }

  const moved = await moveRows(matches.map((m) => m.row.dedupe_key));
  console.log(`Moved ${moved} rows to kind='vapt' (service '${SERVICE}')`);

  const phones = await backfillPhones(matches.map((m) => m.row));
  console.log(`Places phone backfill: ${phones} numbers added`);

  await budget.flush();
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = {   // pure pieces, exported for tests
  TIER2_HINT, FOREIGN_TLD, VENDOR_DOMAINS, isVendorDomain, TOOL,
  classifyPrompt, inList, sameCompany,
};
