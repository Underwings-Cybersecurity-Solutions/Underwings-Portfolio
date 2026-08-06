'use strict';
/*
 * parse.js — pure builders/parsers (no network), ported from the original
 * pandoc-render/lead-sources.js so leadgen is self-contained.
 */

/** Overpass QL: businesses of `category` inside a country's admin area. */
function buildOverpassQL(category, kind = 'office', iso = 'AE', limit = 60) {
  const cat = String(category).replace(/["\\]/g, '');
  const k = kind === 'amenity' ? 'amenity' : 'office';
  return `[out:json][timeout:60];
area["ISO3166-1"="${iso}"][admin_level=2]->.c;
(node["${k}"="${cat}"](area.c);
 way["${k}"="${cat}"](area.c););
out tags center ${Number(limit) || 60};`;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// Anti-scrape obfuscation, which UAE company sites use constantly:
//   "info [at] acme [dot] ae", "info(at)acme(dot)ae", "info @ acme . ae"
// De-obfuscating is just reading what the page displays to any visitor — the
// address is published, only prettified. Handled BEFORE the plain match, so a
// page that writes every address this way stops yielding zero contacts.
const AT = String.raw`(?:\s*(?:\[|\(|\{)?\s*(?:at|@)\s*(?:\]|\)|\})?\s*)`;
const DOT = String.raw`(?:\s*(?:\[|\(|\{)?\s*(?:dot|punto|\.)\s*(?:\]|\)|\})?\s*)`;
const OBFUSCATED_RE = new RegExp(
  `([A-Z0-9._%+-]+)${AT}([A-Z0-9-]+(?:${DOT}[A-Z0-9-]+)+)`, 'gi');

/** "info [at] acme [dot] ae" → "info@acme.ae". Pure; exported for tests. */
function deobfuscateEmails(html) {
  const out = [];
  const s = String(html || '');
  let m;
  OBFUSCATED_RE.lastIndex = 0;
  while ((m = OBFUSCATED_RE.exec(s))) {
    const local = m[1];
    const domain = m[2].replace(new RegExp(DOT, 'gi'), '.').replace(/\.+/g, '.');
    if (/\.[a-z]{2,}$/i.test(domain)) out.push(`${local}@${domain}`.toLowerCase());
  }
  return out;
}

/** All emails in a page, lower-cased + unique, asset-noise dropped. */
function extractEmails(html) {
  const s = String(html || '');
  const found = [...(s.match(EMAIL_RE) || []), ...deobfuscateEmails(s)]
    .map((e) => e.toLowerCase());
  const clean = found.filter(
    (e) => !/\.(png|jpg|jpeg|gif|webp|svg)$/.test(e) &&
           !e.endsWith('example.com') && !e.endsWith('sentry.io') &&
           !e.endsWith('.wixpress.com')
  );
  return [...new Set(clean)];
}

/** hostname (www-stripped) from a URL string, or '' */
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

// UAE legal / trading suffixes. Stripping them before the dedupe key is what
// makes "Wio Bank P.J.S.C." and "WIO Bank" one company: the same organisation
// arrives spelled differently from a news story and from a directory, and a
// bare alphanumeric squash treated them as two prospects.
// Only trailing suffixes are removed — "Gulf Business Machines" keeps every
// word, and nothing here can shorten a name to a different company.
const LEGAL_SUFFIX =
  /\s*\b(l\.?l\.?c|f\.?z\.?c\.?o|f\.?z\.?e|fz[- ]?llc|p\.?j\.?s\.?c|p\.?s\.?c|w\.?l\.?l|l\.?l\.?p|p\.?l\.?c|ltd|limited|inc|incorporated|corp|corporation|co|company|est|establishment|holdings?|dmcc|jlt|sole proprietorship)\b\.?\s*$/i;

/** Company name → dedupe token: legal suffixes stripped, then squashed to
 * alphanumerics. Shared by run.js and store-pg.js so the key the pipeline
 * dedupes on is the key it writes. Pure. */
function normCompany(name) {
  let s = String(name || '').trim();
  for (let i = 0; i < 3 && LEGAL_SUFFIX.test(s); i++) s = s.replace(LEGAL_SUFFIX, '');
  const squashed = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  // never let stripping empty the name (a company literally called "Holdings")
  return squashed || String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Map raw Overpass elements → candidate rows. */
function osmElementsToCandidates(elements, source = 'overpass') {
  return (elements || [])
    .map((el) => {
      const t = el.tags || {};
      const website = t.website || t['contact:website'] || '';
      return {
        company: (t.name || t['name:en'] || '').trim(),
        website,
        domain: domainOf(website),
        email: (t.email || t['contact:email'] || '').toLowerCase(),
        phone: t.phone || t['contact:phone'] || '',
        location: t['addr:city'] || t['addr:state'] || '',
        industry: t.office || t.amenity || '',
        source,
      };
    })
    .filter((c) => c.company);
}

/** Minimal RSS <item> parser → {title, link, description}. */
function parseRssItems(xml) {
  const items = [];
  const blocks = String(xml || '').split(/<item>/i).slice(1);
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[|\]\]>/g, '')
                 .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    };
    items.push({ title: pick('title'), link: pick('link'), description: pick('description') });
  }
  return items.filter((i) => i.title);
}

module.exports = {
  buildOverpassQL, extractEmails, deobfuscateEmails, domainOf, normCompany,
  osmElementsToCandidates, parseRssItems,
};
