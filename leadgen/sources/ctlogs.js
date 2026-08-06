'use strict';
/* ctlogs.js — UAE domains from Certificate Transparency (free, no key).
 *
 * Every publicly-trusted TLS certificate is published to append-only CT logs
 * by the CA. crt.sh is a searchable mirror of those logs, so querying it
 * reads a public archive — the domain owner is never contacted, and nothing
 * here touches a prospect's infrastructure. It is also the single best free
 * source of *UAE-specific* domains: the .ae second-level namespaces
 * (co.ae / net.ae / org.ae / gov.ae / sch.ae) are, by registry policy, UAE
 * organisations only.
 *
 * Candidates arrive domain-first with no company name; Claude infers the
 * organisation from the domain and the website scrape fills in contacts —
 * the same path the news source already takes.
 *
 * Live-verified 2026-08-02:
 *  - Suffix queries work: `?q=%.co.ae` → 200, ~1150 certs / 188 registrable
 *    domains in ~57s.
 *  - LEADING wildcards (`%insurance%.ae`) 502 — too expensive for crt.sh to
 *    run. Don't reintroduce them; sector targeting happens at scoring time.
 *  - crt.sh is FLAKY under load: the same URL that returns 200 in ~22s will
 *    intermittently answer 404 or 502 within a second. A 404 here therefore
 *    means "ask again later", NOT "no such pattern" — hence the explicit
 *    retry below, which lib/http.js won't do for a 404 on its own.
 *  - Responses are slow and large, so ONE pattern per cycle by default and a
 *    90s timeout. Retries are spaced by the pacing governor rather than
 *    hammering: a second 60s query fired immediately is how a cycle stalls.
 */
const cfg = require('../config');
const { getJson } = require('../lib/http');
const { paced } = require('../lib/passive');

const ENDPOINT = 'https://crt.sh';
const UA = 'underwings-leadgen/1.0 (+https://underwings.org)';

// Infrastructure hosts nobody sells consultancy to, plus wildcard artefacts.
const NOISE =
  /^(\*|localhost|autodiscover|autoconfig|cpanel|webmail|webdisk|whm|mail|smtp|imap|pop|ftp|ns\d*|mx\d*|vpn|test|dev|staging|cdn|_)/i;

/** Patterns for this cycle. Pure; exported for tests. */
function patternsForCycle(cycle, patterns = cfg.ctlogs.patterns,
                          perCycle = cfg.ctlogs.perCycle) {
  if (!patterns.length) return [];
  const n = Math.min(perCycle, patterns.length);
  const start = ((cycle % patterns.length) + patterns.length) % patterns.length;
  return Array.from({ length: n }, (_, i) => patterns[(start + i) % patterns.length]);
}

/** A cert's SAN list can hold many names; reduce each to its registrable
 * domain under a .ae second level (`x.y.co.ae` → `y.co.ae`). Pure. */
function registrableOf(name, suffix) {
  const host = String(name || '').trim().toLowerCase().replace(/^\*\./, '');
  if (!host.endsWith(suffix) || NOISE.test(host)) return '';
  const labels = host.split('.');
  const keep = suffix.split('.').length + 1;   // e.g. co.ae → 3 labels
  if (labels.length < keep) return '';
  return labels.slice(-keep).join('.');
}

/** crt.sh rows → deduped candidates. Pure; exported for tests. */
function toCandidates(rows, suffix) {
  const domains = new Set();
  for (const r of rows || []) {
    for (const n of String((r && r.name_value) || '').split('\n')) {
      const d = registrableOf(n, suffix);
      if (d) domains.add(d);
    }
  }
  return [...domains].map((domain) => ({
    company: '', website: `https://${domain}`, domain,
    email: '', phone: '', location: 'United Arab Emirates',
    industry: '', source: 'ctlogs',
    signal: `UAE domain ${domain} (certificate transparency, ${suffix} registry)`,
  }));
}

/** crt.sh answers a transient 404/502 as readily as a real one. Retry those
 * a couple of times, paced, before believing the pattern is empty. */
const TRANSIENT = /HTTP (404|429|50\d) /;

async function fetchPattern(pattern) {
  const url = `${ENDPOINT}/?q=${encodeURIComponent(pattern)}` +
    '&output=json&exclude=expired';   // without exclude=expired crt.sh 502s
  let lastErr;
  for (let attempt = 0; attempt <= cfg.ctlogs.attempts; attempt++) {
    try {
      return await paced(url,
        () => getJson(url, { headers: { 'User-Agent': UA } },
          { timeoutMs: cfg.ctlogs.timeoutMs, retries: 0 }),
        { minIntervalMs: attempt ? cfg.ctlogs.retryIntervalMs : cfg.ctlogs.minIntervalMs });
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT.test(String(e.message || ''))) throw e;
    }
  }
  throw lastErr;
}

async function ctlogs(env, cycle = 0) {
  const out = [];
  for (const pattern of patternsForCycle(cycle)) {
    const suffix = pattern.replace(/^%\./, '');
    try {
      const rows = await fetchPattern(pattern);
      out.push(...toCandidates(rows, suffix).slice(0, cfg.ctlogs.perPattern));
    } catch (e) { console.warn(`  [ctlogs:${pattern}] ${e.message}`); }
  }
  return out;
}

module.exports = { ctlogs, patternsForCycle, toCandidates, registrableOf, NOISE };
