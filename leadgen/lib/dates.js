'use strict';
/* dates.js — helpers for the S "Dates" cell:
 * "added 2026-07-24 · verified 2026-08-20" (verified part optional). */

const DAY_MS = 24 * 60 * 60 * 1000;

const today = () => new Date().toISOString().slice(0, 10);

function formatDates({ added, verified }) {
  let s = `added ${added}`;
  if (verified) s += ` · verified ${verified}`;
  return s;
}

function parseDates(cell) {
  const s = String(cell || '');
  const added = (s.match(/added (\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  const verified = (s.match(/verified (\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  return { added, verified };
}

/** Whole days from dateStr to ref (default today). Empty/invalid → Infinity. */
function daysSince(dateStr, ref = today()) {
  if (!dateStr) return Infinity;
  const a = Date.parse(dateStr);
  const b = Date.parse(ref);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.floor((b - a) / DAY_MS);
}

module.exports = { formatDates, parseDates, daysSince, today };
