'use strict';
/*
 * supabase.js — the thinnest possible PostgREST client. Zero npm deps, built
 * on lib/http.js so it inherits the timeout + transient-status retry.
 *
 * The pipeline authenticates as service_role, which bypasses RLS and holds
 * full UPDATE on crm_prospects. That is deliberate: migration 011 revokes
 * enrichment-column UPDATE from `authenticated`, so the pipeline owns the
 * enrichment columns and the browser owns status/notes. Never hand this key
 * to anything that faces a browser.
 *
 * Env: SUPABASE_URL (default http://kong:8000), SERVICE_ROLE_KEY.
 */
const { request } = require('./http');

const baseUrl = () => (process.env.SUPABASE_URL || 'http://kong:8000').replace(/\/+$/, '');
const serviceKey = () => process.env.SERVICE_ROLE_KEY || '';

function headers(extra = {}) {
  const key = serviceKey();
  if (!key) throw new Error('SERVICE_ROLE_KEY not set');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** GET /rest/v1/<path>. `query` is an object of PostgREST params. */
async function select(table, query = {}, extraHeaders = {}) {
  const qs = new URLSearchParams(query).toString();
  const res = await request(
    `${baseUrl()}/rest/v1/${table}${qs ? `?${qs}` : ''}`,
    { method: 'GET', headers: headers(extraHeaders) },
    { timeoutMs: 30000, retries: 2 });
  return res.json();
}

/** POST /rest/v1/<table>. Returns the representation rows PostgREST echoes. */
async function insert(table, rows, { onConflict, ignoreDuplicates = false } = {}) {
  if (!rows || !rows.length) return [];
  const params = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  const prefer = [
    'return=representation',
    ignoreDuplicates ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates',
  ].join(',');
  const res = await request(`${baseUrl()}/rest/v1/${table}${params}`, {
    method: 'POST',
    headers: headers({ Prefer: prefer }),
    body: JSON.stringify(rows),
  }, { timeoutMs: 45000, retries: 1 });
  return res.json();
}

/** PATCH /rest/v1/<table>?<match>. Returns the updated rows. */
async function update(table, match, fields) {
  const qs = new URLSearchParams(match).toString();
  const res = await request(`${baseUrl()}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(fields),
  }, { timeoutMs: 30000, retries: 1 });
  return res.json();
}

/** POST /rest/v1/rpc/<fn>. */
async function rpc(fn, args = {}) {
  const res = await request(`${baseUrl()}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(args),
  }, { timeoutMs: 30000, retries: 1 });
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

module.exports = { select, insert, update, rpc, baseUrl, serviceKey };
