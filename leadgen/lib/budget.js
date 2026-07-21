'use strict';
/*
 * budget.js — per-source monthly call counter, persisted to state/usage.json.
 * A hard backstop so paid APIs (Places, Hunter) can never run past a monthly cap.
 * Shape: { "YYYY-MM": { "google-places": N, "hunter": N } } — only the current
 * month is kept (older months are pruned on write).
 */
const fs = require('fs');
const path = require('path');

const USAGE_PATH = path.join(__dirname, '..', 'state', 'usage.json');
const month = () => new Date().toISOString().slice(0, 7); // YYYY-MM

function load() {
  try { return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8')); }
  catch { return {}; }
}
function save(d) {
  try { fs.writeFileSync(USAGE_PATH, JSON.stringify(d)); } catch { /* best effort */ }
}

/** Calls already made this month for `name`. */
function used(name) {
  return (load()[month()] || {})[name] || 0;
}

/** How many calls remain before hitting `cap` this month. */
function remaining(name, cap) {
  return Math.max(0, cap - used(name));
}

/** Record `n` calls against `name` for the current month (prunes old months). */
function spend(name, n = 1) {
  const d = load();
  const m = month();
  const cur = d[m] || {};
  cur[name] = (cur[name] || 0) + n;
  save({ [m]: cur }); // keep only the current month
  return cur[name];
}

module.exports = { used, remaining, spend };
