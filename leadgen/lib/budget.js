'use strict';
/*
 * budget.js — monthly call counter for paid APIs, keyed on the API KEY rather
 * than on this checkout directory.
 *
 * Why that matters: the previous implementation (and Al Khaznah's, still) kept
 * the counter in state/usage.json under the project directory. Underwings and
 * Al Khaznah share the Firecrawl key, so each project happily spent up to its
 * own cap and the real plan was blown through at up to 2x the intended rate.
 * Counting against a hash of the key in crm_leadgen_usage means any project
 * that adopts this module shares one counter per key automatically. (Apollo is
 * Underwings' own key, but keying by hash costs nothing and stays correct if
 * it's ever shared.)
 *
 * The read API stays SYNCHRONOUS (`used`/`remaining`/`spend`) because it is
 * called inside tight per-lead loops in run.js and every source. sync() loads
 * the month's counters into memory once per cycle; spend() updates memory
 * immediately and queues a durable increment; flush() awaits those writes at
 * the end of the cycle.
 */
const crypto = require('crypto');
const db = require('./supabase');

const month = () => new Date().toISOString().slice(0, 7); // YYYY-MM

// source name → the env var holding the API key it spends
const KEY_ENV = {
  firecrawl: 'FIRECRAWL_API_KEY',
  'apollo-search': 'APOLLO_API_KEY',
  'apollo-match': 'APOLLO_API_KEY',
  'apollo-org': 'APOLLO_API_KEY',
  'google-places': 'GOOGLE_PLACES_API_KEY',
};

let mem = {};                    // { 'firecrawl': 42 }
let chain = Promise.resolve();   // serialized durable writes
let offline = false;             // true once the RPC has failed — degrade, don't crash

/** Stable, non-reversible reference to a key. Never store the key itself. */
function keyRef(name) {
  const raw = process.env[KEY_ENV[name] || ''] || '';
  if (!raw) return `nokey:${name}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** Load this month's counters for every known source into memory. Call once
 * per cycle, before any source runs. */
async function sync() {
  mem = {};
  offline = false;
  try {
    const rows = await db.select('crm_leadgen_usage', {
      select: 'key_ref,source,count', month: `eq.${month()}`,
    });
    if (!Array.isArray(rows)) throw new Error('unexpected usage response');
    for (const name of Object.keys(KEY_ENV)) {
      const ref = keyRef(name);
      const hit = rows.find((r) => r.key_ref === ref && r.source === name);
      mem[name] = hit ? hit.count : 0;
    }
  } catch (e) {
    // Fail CLOSED: if we cannot read the counters we cannot prove we are under
    // cap, so behave as if every budget is exhausted. Free sources still run.
    offline = true;
    for (const name of Object.keys(KEY_ENV)) mem[name] = Number.MAX_SAFE_INTEGER;
    console.warn(`  [budget] cannot read usage (${e.message}) — paid sources disabled this cycle`);
  }
  return mem;
}

/** Calls already made this month for `name`. */
function used(name) {
  return mem[name] || 0;
}

/** How many calls remain before hitting `cap` this month. */
function remaining(name, cap) {
  return Math.max(0, cap - used(name));
}

/** Record `n` calls against `name`. Memory updates immediately (so the very
 * next remaining() sees it); the durable write is queued and awaited by
 * flush(). Callers spend BEFORE the request, so a failed API call still burns
 * the counter — over-counting is cheaper than over-spending. */
function spend(name, n = 1) {
  mem[name] = (mem[name] || 0) + n;
  if (!offline) {
    chain = chain.then(() =>
      db.rpc('crm_leadgen_spend', {
        p_key_ref: keyRef(name), p_month: month(), p_source: name, p_n: n,
      })).catch((e) => {
      console.warn(`  [budget] failed to persist spend(${name}, ${n}): ${e.message}`);
    });
  }
  return mem[name];
}

/** Await every queued durable increment. Call at the end of a cycle. */
function flush() {
  return chain;
}

/** Test seam: prime the in-memory counters without touching the database. */
function _setMemory(next, isOffline = false) {
  mem = { ...next };
  offline = isOffline;
  chain = Promise.resolve();
}

module.exports = { used, remaining, spend, sync, flush, keyRef, month, _setMemory, KEY_ENV };
