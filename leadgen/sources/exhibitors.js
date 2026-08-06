'use strict';
/* exhibitors.js — trade-show exhibitor directories: the highest-precision
 * source (curated lists of leather-industry companies). Firecrawl scrape →
 * markdown → generic link extractor. Budget-capped ('firecrawl'). */
const cfg = require('../config');
const { getJson } = require('../lib/http');
const { domainOf } = require('../lib/parse');
const budget = require('../lib/budget');

const NAV_WORDS = /^(home|about( us)?|contact( us)?|exhibitors?( list)?|visitors?|tickets?|news|press|blog|privacy( policy)?|cookies?( policy)?|terms( of use| and conditions)?|login|log in|register|sign (in|up)|search|menu|next|previous|prev|back|more|see all|view all|book( now)?|apply|faq|program(me)?|agenda|sponsors?|partners?|venue|floor ?plan|download|subscribe|newsletter|share|facebook|twitter|linkedin|instagram|youtube|english|italiano|français|deutsch|español)$/i;

// Some exhibitor directories render as a plain markdown table (no per-company
// links) — e.g. "| Hall | Company | Country | Pavilion |". Harvest the column
// under a company/exhibitor-labelled header.
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP_RE = /^:?-{2,}:?$/;
const COMPANY_HEADER_RE = /^(company( name)?|exhibitor( name)?)$/i;

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** Scan pipe-table blocks in `md`; return company-name strings found under a
 * "Company"/"Exhibitor" header column. Tables without such a header are
 * ignored (e.g. cookie-consent tables) so this stays low-noise. */
function extractTableCompanyNames(md) {
  const lines = String(md || '').split(/\r?\n/);
  const names = [];
  let i = 0;
  while (i < lines.length) {
    if (!TABLE_ROW_RE.test(lines[i])) { i++; continue; }
    const header = splitTableRow(lines[i]);
    let row = i + 1;
    if (row < lines.length && TABLE_ROW_RE.test(lines[row]) &&
        splitTableRow(lines[row]).every((c) => TABLE_SEP_RE.test(c))) row++;
    const colIdx = header.findIndex((h) => COMPANY_HEADER_RE.test(h));
    let j = row;
    while (j < lines.length && TABLE_ROW_RE.test(lines[j])) {
      if (colIdx >= 0) {
        const cells = splitTableRow(lines[j]);
        if (cells[colIdx]) names.push(cells[colIdx]);
      }
      j++;
    }
    i = j > i ? j : i + 1;
  }
  return names;
}

// Some exhibitor catalogues (e.g. a fair's own show-floor app) render each
// exhibitor as plain text — a name line, then a hall/stand-code line — with
// no markdown links or tables at all. A stand code looks like "11P M11 - M21"
// (1-3 digit hall + optional letter, then space-separated booth refs).
const STAND_CODE_RE = /^\d{1,3}[A-Z]{0,2}\s+[A-Z0-9][A-Z0-9,.\- ]{0,40}$/;
const NON_CANDIDATE_LINE_RE = /^[#>*\-|!\[]/;

/** Scan plain-text lines in `md`; return the name immediately preceding a
 * stand/booth-code line as a company-name candidate. */
function extractPlainAdjacentCompanyNames(md) {
  const lines = String(md || '').split(/\r?\n/).map((l) => l.trim());
  const names = [];
  let candidate = '';
  for (const line of lines) {
    if (!line) continue;
    if (STAND_CODE_RE.test(line)) {
      if (candidate) names.push(candidate);
      candidate = '';
      continue;
    }
    if (NON_CANDIDATE_LINE_RE.test(line) || /\]\(/.test(line)) { candidate = ''; continue; }
    candidate = line;
  }
  return names;
}

/** Markdown links, table columns, and name/stand-code plain-text pairs →
 * company candidates. External links become the website; show-internal
 * links and non-link sources contribute the name only. Dedupes by name
 * (external link wins, and is tried first). Pure; exported for tests. */
function extractCompaniesFromMarkdown(md, showDomain, source, limit) {
  const raw = String(md || '');
  const out = new Map();

  const tryAdd = (rawName, url) => {
    const name = String(rawName || '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
    if (!name || name.length < 3 || name.length > 80) return;
    if (/^\d+$/.test(name) || NAV_WORDS.test(name)) return;
    const d = url ? domainOf(url) : '';
    const external = d && d !== showDomain && !d.endsWith('.' + showDomain);
    const key = name.toLowerCase();
    const prev = out.get(key);
    if (!prev && out.size >= limit) return; // cap NEW companies; upgrades still allowed
    if (!prev || (external && !prev.website)) {
      out.set(key, {
        company: name, website: external ? url : '', domain: external ? d : '',
        email: '', phone: '', location: '', industry: '', source,
      });
    }
  };

  const linkRe = /\[([^\]\n]{2,80})\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = linkRe.exec(raw))) {
    const url = m[2];
    if (/\.(png|jpe?g|svg|gif|webp|pdf)(\?|$)/i.test(url)) continue;
    tryAdd(m[1], url);
  }
  for (const name of extractTableCompanyNames(raw)) tryAdd(name, null);
  for (const name of extractPlainAdjacentCompanyNames(raw)) tryAdd(name, null);

  return [...out.values()];
}

/** Which shows to scrape on cycle N (rotates; deterministic). */
function showsForCycle(cycle, ex = cfg.exhibitors) {
  const n = Math.min(ex.showsPerCycle, ex.shows.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push(ex.shows[(cycle * n + i) % ex.shows.length]);
  return out;
}

async function exhibitors(env, cycle) {
  const key = env.FIRECRAWL_API_KEY;
  if (!key) { console.log('  [exhibitors] skipped — no FIRECRAWL_API_KEY'); return []; }
  if (!cfg.exhibitors.shows.length) {
    console.log('  [exhibitors] skipped — no verified show directories configured (see config.js)');
    return [];
  }
  const out = [];
  for (const show of showsForCycle(cycle)) {
    if (budget.remaining('firecrawl', cfg.firecrawl.monthlyCap) <= 0) {
      console.log('  [exhibitors] firecrawl monthly cap reached — stopping'); break;
    }
    budget.spend('firecrawl', 1);
    try {
      const j = await getJson('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        // excludeTags: a couple of shows ship hidden admin-template demo
        // drawers (chat/activity-feed/help widgets) in their markup that
        // Firecrawl otherwise renders as bogus "companies" — inert selectors
        // elsewhere, so safe to send for every show.
        body: JSON.stringify({
          url: show.url, formats: ['markdown'],
          excludeTags: ['#kt_activities', '#kt_drawer_chat', '#kt_help'],
        }),
      }, { timeoutMs: 90000, retries: 1 });
      const found = extractCompaniesFromMarkdown(
        j.data?.markdown || '', domainOf(show.url),
        `exhibitors:${show.name}`, cfg.exhibitors.perShowLimit);
      console.log(`  [exhibitors:${show.name}] ${found.length} companies`);
      out.push(...found);
    } catch (e) { console.warn(`  [exhibitors:${show.name}] ${e.message}`); }
  }
  return out;
}

module.exports = { exhibitors, extractCompaniesFromMarkdown, showsForCycle };
