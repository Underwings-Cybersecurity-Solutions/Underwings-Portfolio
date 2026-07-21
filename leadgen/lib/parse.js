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

/** All emails in a page, lower-cased + unique, asset-noise dropped. */
function extractEmails(html) {
  const found = (String(html || '').match(EMAIL_RE) || []).map((e) => e.toLowerCase());
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
  buildOverpassQL, extractEmails, domainOf, osmElementsToCandidates, parseRssItems,
};
