'use strict';
/* news.js — Google News RSS trigger-event signals (free).
 * Edition is UAE (en-AE/AE) so breach and compliance stories are ranked for
 * this market rather than the US one. */
const cfg = require('../config');
const { getText } = require('../lib/http');
const P = require('../lib/parse');

const newsUrl = (query) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-AE&gl=AE&ceid=AE:en`;

async function googleNews() {
  const out = [];
  for (const query of cfg.googleNews.queries) {
    try {
      const xml = await getText(newsUrl(query));
      for (const it of P.parseRssItems(xml).slice(0, cfg.googleNews.perQueryLimit)) {
        out.push({
          company: '', website: '', domain: '', email: '', phone: '',
          location: '', industry: '', source: 'google-news',
          signal: `${it.title} — ${it.description}`.slice(0, 300),
        });
      }
    } catch (e) { console.warn(`  [google-news:${query}] ${e.message}`); }
  }
  return out;
}

module.exports = { googleNews, newsUrl };
