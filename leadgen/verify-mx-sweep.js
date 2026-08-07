'use strict';
/* verify-mx-sweep.js — one-off (2026-08-07): clear the MX backlog in one go
 * instead of 150 domains/cycle. Same pass as run.js's mxSweep, uncapped, and
 * it seeds state/mx.json so the per-cycle pass starts warm.
 *
 *   docker exec underwings-leadgen node verify-mx-sweep.js
 */
const path = require('path');
const mx = require('./lib/mx');
const db = require('./lib/supabase');
const cfg = require('./config');

(async () => {
  const t0 = Date.now();
  const stats = await mx.sweep({
    db,
    cachePath: path.join(__dirname, 'state', 'mx.json'),
    maxDomains: Infinity,
    recheckDays: cfg.mx.recheckDays,
    concurrency: 20,
  });
  console.log(`MX backlog sweep: ${stats.checked} domains in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`  dead: ${stats.dead} → ${stats.invalidated} contacts marked invalid`);
  console.log(`  DNS-unknown (will retry next cycles): ${stats.unknown}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
