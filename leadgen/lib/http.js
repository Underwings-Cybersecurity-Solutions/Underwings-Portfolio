'use strict';
/* http.js — fetch helpers with timeout + light retry. Built-in fetch only. */

const UA = 'UnderwingsLeadGen/1.0 (+https://underwings.org; contact@underwings.org)';

async function request(url, opts = {}, { timeoutMs = 45000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...opts,
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      });
      clearTimeout(timer);
      if (!res.ok) {
        // retry only on transient statuses
        if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
          await sleep(1500 * (attempt + 1)); continue;
        }
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} for ${url} :: ${body.slice(0, 200)}`);
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
    }
  }
  throw lastErr;
}

async function getText(url, opts) { return (await request(url, opts)).text(); }
async function getJson(url, opts) { return (await request(url, opts)).json(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { request, getText, getJson, sleep, UA };
