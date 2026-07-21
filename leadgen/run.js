'use strict';
/*
 * run.js — orchestrator.
 *   gather (6 sources) → dedupe → Claude score → harvest contacts
 *   (emails + phones) → write into the Leads tab.
 * One-shot:        node run.js
 * Continuous:      node run.js --loop            (every config.intervalMinutes)
 * Backfill existing rows' contacts: node run.js --enrich-existing
 *
 * Env: ANTHROPIC_API_KEY, GOOGLE_SA_KEY_PATH (default ./sa.json),
 *      optional GOOGLE_PLACES_API_KEY, FIRECRAWL_API_KEY.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const sheetsLib = require('./lib/sheets');
const sources = require('./sources');
const { enrich } = require('./lib/enrich');
const { harvestContacts } = require('./lib/contacts');
const hunter = require('./lib/hunter');
const budget = require('./lib/budget');
const { sleep } = require('./lib/http');

const SEEN_PATH = path.join(__dirname, 'state', 'seen.json');
const MONTH_PATH = path.join(__dirname, 'state', 'month.json');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const keyOf = (c) => c.domain ? `d:${c.domain}` : `c:${norm(c.company)}`;

// On the first run of a new month, clear dedup memory so the fresh sheet
// re-discovers companies (osint archives + clears the sheet on its daily run).
function monthRollover() {
  const now = new Date().toISOString().slice(0, 7);
  let stored = null;
  try { stored = JSON.parse(fs.readFileSync(MONTH_PATH, 'utf8')).month; } catch { /* */ }
  if (stored && stored !== now) {
    try { fs.writeFileSync(SEEN_PATH, '[]'); } catch { /* */ }
    console.log(`month rollover ${stored} → ${now}: cleared dedup memory`);
  }
  try { fs.writeFileSync(MONTH_PATH, JSON.stringify({ month: now })); } catch { /* */ }
}

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'))); }
  catch { return new Set(); }
}
function saveSeen(set) {
  const arr = [...set].slice(-5000); // cap memory file
  fs.writeFileSync(SEEN_PATH, JSON.stringify(arr));
}

// Contact-focused layout (17 cols A–Q).
const COL = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q'];

function toRow(lead, number) {
  const r = new Array(COL.length).fill('');
  r[0]  = number;                                   // A #
  r[1]  = lead.company;                             // B Company
  r[2]  = lead.contactName || '';                   // C Contact Name (person)
  r[3]  = lead.target_title || '';                  // D Title
  r[4]  = lead.email || '';                         // E Email (person > role)
  r[5]  = lead.emailStatus || '';                   // F Email Status
  r[6]  = lead.phone || '';                         // G Phone
  r[7]  = lead.linkedin || '';                      // H LinkedIn
  r[8]  = lead.website || '';                       // I Website
  r[9]  = lead.industry || '';                      // J Industry
  r[10] = lead.service || '';                        // K Service
  r[11] = lead.icp_score;                           // L AI Score
  // M Gap Score + N Security Talking Points are filled in-place by the osint profiler
  r[14] = 'New (AI)';                               // O Status
  r[15] = lead.summary + (lead.opener ? ` | Opener: ${lead.opener}` : ''); // P Notes
  r[16] = new Date().toISOString().slice(0, 10);    // Q Date Added
  return r;
}

/** Harvest emails+phones; free website-scrape first, Hunter.io fallback. Mutates leads. */
async function harvestAll(leads) {
  let withEmail = 0, withPerson = 0;
  const hunterKey = process.env.HUNTER_API_KEY;
  for (const l of leads) {
    // 1. free website scrape → role emails (info@/sales@) + phone
    if (l.website) {
      try {
        const c = await harvestContacts(l.website, l.phone);
        if (c.emails.length) {
          l.allEmails = c.emails;
          if (!l.email) { l.email = c.best; l.emailStatus = 'role'; }
        }
        if (c.phones.length && !l.phone) l.phone = c.phones[0];
      } catch { /* best effort */ }
    }
    // 2. Hunter.io → named PERSON email (gated + budget-capped); overrides role email
    if (hunterKey && l.domain && budget.remaining('hunter-search', cfg.hunter.searchCap) > 0) {
      budget.spend('hunter-search', 1);
      const p = await hunter.findContact(l.domain, hunterKey);
      if (p && p.email) {
        l.contactName = p.name;
        if (p.title) l.target_title = p.title;          // real person title
        l.email = p.email;                              // person email wins
        l.emailStatus = p.status;
        if (p.linkedin) l.linkedin = p.linkedin;
        l.allEmails = [...new Set([...(l.allEmails || []), ...p.all])];
        if (cfg.hunter.verify && budget.remaining('hunter-verify', cfg.hunter.verifyCap) > 0) {
          budget.spend('hunter-verify', 1);
          l.emailStatus = await hunter.verify(p.email, hunterKey); // deliverable|risky|…
        }
        if (p.name) withPerson++;
      }
    }
    if (l.email) withEmail++;
  }
  console.log(`Harvested: ${withEmail}/${leads.length} emails (${withPerson} named contacts)`);
  return leads;
}

async function runOnce() {
  const t0 = Date.now();
  console.log(`\n=== leadgen run @ ${new Date().toISOString()} ===`);
  monthRollover();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const saPath = process.env.GOOGLE_SA_KEY_PATH || path.join(__dirname, 'sa.json');
  const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));

  // --- Sheets client + existing rows for dedupe / first empty row ---
  const token = await sheetsLib.getAccessToken(sa);
  const sheet = sheetsLib.makeClient(sa, cfg.sheet.id, token);
  const tab = cfg.sheet.tab;
  const existingCompanies = (await sheet.read(`${tab}!B${cfg.sheet.firstDataRow}:B`)).flat();
  const existingSites = (await sheet.read(`${tab}!I${cfg.sheet.firstDataRow}:I`)).flat();
  const firstEmptyOffset = existingCompanies.findIndex((v) => !v || !v.trim());
  const startRow = cfg.sheet.firstDataRow +
    (firstEmptyOffset === -1 ? existingCompanies.length : firstEmptyOffset);

  const seen = loadSeen();
  for (const c of existingCompanies) seen.add(`c:${norm(c)}`);
  for (const s of existingSites) { const d = s && s.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]; if (d) seen.add(`d:${d.toLowerCase()}`); }

  // --- gather from all sources ---
  console.log('Gathering from sources…');
  const bySource = await sources.gatherAll(process.env);
  let candidates = Object.values(bySource).flat();

  // --- dedupe (within batch + vs sheet/seen) ---
  const batchSeen = new Set();
  candidates = candidates.filter((c) => {
    if (!c.company && !c.signal) return false;
    const k = keyOf(c);
    if (c.company && (seen.has(k) || batchSeen.has(k))) return false;
    if (c.company) batchSeen.add(k);
    return true;
  });
  console.log(`Deduped → ${candidates.length} new candidates`);

  // --- cap, score with Claude ---
  candidates = candidates.slice(0, cfg.maxCandidatesPerRun);
  console.log(`Scoring ${candidates.length} with Claude (${cfg.claudeModel})…`);
  const leads = await enrich(apiKey, candidates);
  leads.sort((a, b) => (b.icp_score || 0) - (a.icp_score || 0));
  console.log(`Claude kept ${leads.length} leads`);

  if (!leads.length) { console.log('No leads to write this cycle.'); return 0; }

  // --- harvest emails + phones for kept leads ---
  console.log('Harvesting emails/phones from websites…');
  await harvestAll(leads);

  // --- write rows (headers are persistent in the sheet) ---
  const rows = leads.map((l, i) => toRow(l, startRow - cfg.sheet.firstDataRow + 1 + i));
  await sheet.write(`${tab}!A${startRow}:Q${startRow + rows.length - 1}`, rows);

  for (const l of leads) seen.add(keyOf(l));
  saveSeen(seen);
  console.log(`✅ Wrote ${rows.length} leads to ${tab}!A${startRow} (${Date.now() - t0}ms)`);
  return rows.length;
}

/** Backfill emails/phones for rows already in the sheet (those with a website). */
async function enrichExisting() {
  console.log(`\n=== enrich-existing @ ${new Date().toISOString()} ===`);
  const saPath = process.env.GOOGLE_SA_KEY_PATH || path.join(__dirname, 'sa.json');
  const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  const token = await sheetsLib.getAccessToken(sa);
  const sheet = sheetsLib.makeClient(sa, cfg.sheet.id, token);
  const tab = cfg.sheet.tab;
  const rows = await sheet.read(`${tab}!A${cfg.sheet.firstDataRow}:Q1000`);
  const updates = [];
  let done = 0, hit = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; const rowNum = cfg.sheet.firstDataRow + i;
    const company = r[1]; const website = r[8]; const curEmail = r[4]; const curPhone = r[6];
    if (!company || !website) continue;
    done++;
    let c; try { c = await harvestContacts(website, curPhone); } catch { continue; }
    if (!c.emails.length && !c.phones.length) continue;
    hit++;
    if (c.best && !curEmail) {
      updates.push({ range: `${tab}!E${rowNum}`, values: [[c.best]] });   // Email
      updates.push({ range: `${tab}!F${rowNum}`, values: [['role']] });    // Email Status
    }
    if (c.phones.length && !curPhone) updates.push({ range: `${tab}!G${rowNum}`, values: [[c.phones[0]]] }); // Phone
    console.log(`  ${company.slice(0,30)} → ${c.emails.length} email(s)`);
  }
  await sheet.batchWrite(updates);
  console.log(`✅ enrich-existing: scanned ${done} sites, ${hit} yielded contacts, ${updates.length} cells updated`);
}

/** Ping Uptime Kuma after a successful cycle (no-op unless KUMA_PUSH_URL is set). */
async function heartbeat(n) {
  const url = process.env.KUMA_PUSH_URL;
  if (!url) return;
  try {
    await fetch(`${url}?status=up&msg=${encodeURIComponent(`wrote ${n} leads`)}`,
      { signal: AbortSignal.timeout(10000) });
  } catch { /* monitoring is best-effort */ }
}

async function main() {
  if (process.argv.includes('--enrich-existing')) { await enrichExisting(); return; }
  const loop = process.argv.includes('--loop');
  if (!loop) { await runOnce(); return; }
  console.log(`Continuous mode — every ${cfg.intervalMinutes} min`);
  for (;;) {
    try { const n = await runOnce(); await heartbeat(n); }
    catch (e) { console.error('run failed:', e.message); }
    await sleep(cfg.intervalMinutes * 60 * 1000);
  }
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
