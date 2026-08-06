'use strict';
/*
 * passive.js — politeness governor for the OSINT sources.
 *
 * Everything these sources touch is a PUBLIC ARCHIVE (certificate
 * transparency logs, Wikipedia, GitHub's public API, RSS) — never the
 * prospect's own infrastructure. That is the passive/active line, and it is
 * the one that matters: we read what third parties already publish, so a
 * target never sees a request from us at all until a human decides to visit
 * their site.
 *
 * On top of that, requests are serialised PER HOST with a floor interval and
 * jitter. A burst of parallel requests is what gets an IP throttled or
 * banned, and these archives are free infrastructure run for everyone — one
 * slow polite reader is the whole deal. The cycle already takes ~10 minutes;
 * spending a few more is free, since nothing downstream is waiting.
 */

const DEFAULT_MIN_MS = 2500;

// host → { last, chain } — chain serialises callers so two awaits on the same
// host can't both observe the same `last` and fire together.
const hosts = new Map();

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url); }
}

/** Deterministic-enough jitter without Math.random: spreads successive waits
 * so a fixed interval never becomes a recognisable metronome. */
let tick = 0;
function jitter(span) {
  tick = (tick * 1103515245 + 12345) & 0x7fffffff;
  return span ? tick % span : 0;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` no sooner than `minIntervalMs` (+ jitter) after the previous call
 * for the same host. Returns fn's value; failures still hold the slot open so
 * an error can't turn into a retry storm. */
async function paced(url, fn, { minIntervalMs = DEFAULT_MIN_MS, jitterMs = 700 } = {}) {
  const host = hostOf(url);
  const state = hosts.get(host) || { last: 0, chain: Promise.resolve() };
  hosts.set(host, state);

  const run = state.chain.then(async () => {
    const gap = Date.now() - state.last;
    const need = minIntervalMs + jitter(jitterMs) - gap;
    if (need > 0) await wait(need);
    try { return await fn(); }
    finally { state.last = Date.now(); }
  });
  // the chain must survive a rejection, or every later caller on this host
  // inherits the failure and skips its wait
  state.chain = run.catch(() => {});
  return run;
}

/** Test seam: forget all pacing state. */
function _reset() { hosts.clear(); tick = 0; }

module.exports = { paced, hostOf, _reset, DEFAULT_MIN_MS };
