'use strict';
/*
 * sheets.js — Google Sheets access via a service-account JWT (zero deps).
 * Signs RS256 with built-in crypto, exchanges for an access token, then
 * reads/writes values over the Sheets v4 REST API.
 */
const crypto = require('crypto');
const { getJson, request } = require('./http');

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const data = `${header}.${claims}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(data), sa.private_key);
  return `${data}.${b64url(sig)}`;
}

async function getAccessToken(sa) {
  const res = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(sa),
    }).toString(),
  });
  return (await res.json()).access_token;
}

function makeClient(sa, sheetId, token) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`;
  const auth = { Authorization: `Bearer ${token}` };
  return {
    async read(range) {
      const url = `${base}/values/${encodeURIComponent(range)}`;
      const j = await getJson(url, { headers: auth });
      return j.values || [];
    },
    async write(range, values) {
      const url = `${base}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
      const res = await request(url, {
        method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      return res.json();
    },
    // data: [{ range, values }, ...] — update many ranges in one call.
    async batchWrite(data) {
      if (!data.length) return {};
      const url = `${base}/values:batchUpdate`;
      const res = await request(url, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'RAW', data }),
      });
      return res.json();
    },
  };
}

module.exports = { getAccessToken, makeClient };
