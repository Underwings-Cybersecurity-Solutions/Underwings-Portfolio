'use strict';
/* outreach.test.js — the pure halves of the cold-email drafter: the prompt,
 * the fixed-skeleton composer (the template IS the feature since 2026-08-05),
 * and the merge-back. Network drafting is covered by the same
 * forced-tool-use plumbing enrich.js uses. */
const test = require('node:test');
const assert = require('node:assert');
const O = require('../lib/outreach');

const lead = (over = {}) => ({
  company: 'Gulf Reach Logistics', service: 'GRC / ISO 27001',
  industry: 'Logistics & Supply Chain', emirate: 'Dubai',
  country: 'United Arab Emirates',
  why: 'ISO 27001 renewal due; no in-house security team',
  ...over,
});

const slots = (over = {}) => ({
  sector: 'logistics', services: 'ISO 27001 audit readiness and penetration testing',
  block: 'Logistics firms face ISO 27001 renewal audits while running lean IT teams.',
  ...over,
});

test('the prompt explains the slots and carries the per-lead drivers', () => {
  const p = O.buildPrompt([lead({ signal: 'targeted by Incransom last week' })]);
  assert.match(p, /ONLY three slots/);
  assert.match(p, /sector/);
  assert.match(p, /services/);
  assert.match(p, /block/);
  assert.match(p, /ADHICS/);                       // real standards, not vague "compliance"
  assert.match(p, /Never invent facts/i);
  assert.match(p, /ISO 27001 renewal due/);
  assert.match(p, /targeted by Incransom/);
  assert.match(p, /kind="partner"/);               // partner angle = outbound lead-gen
});

test('composeEmail builds the exact approved skeleton', () => {
  const r = O.composeEmail(lead({ contactName: 'Rashid Al Mansoori' }), slots());
  assert.strictEqual(r.subject, 'Logistics security — worth 15 minutes?');
  assert.match(r.body, /^Hi Rashid,\n\n/);
  assert.match(r.body, /Quick note from Underwings Cybersecurity Solutions\. We work with logistics organisations on ISO 27001 audit readiness and penetration testing\./);
  assert.match(r.body, /ISO 27001 renewal audits/);            // the block landed
  assert.match(r.body, /I'm not asking you to switch anything/);
  assert.ok(r.body.includes(O.CALENDLY_URL));
  assert.ok(r.body.includes(O.ASSESSMENT_URL));
  assert.match(r.body, /Regards,\n\[YOUR NAME\]\n\[TITLE\] \| Underwings Cybersecurity Solutions\n\+971 505670394 \| https:\/\/underwings\.org$/);
});

test('composeEmail greets Hello without a contact and keeps acronym casing', () => {
  const r = O.composeEmail(lead(), slots({ sector: 'IT services' }));
  assert.match(r.body, /^Hello,\n\n/);
  assert.strictEqual(r.subject, 'IT services security — worth 15 minutes?');
  assert.ok(r.subject.length < 60);
});

test('composeEmail refuses a partial slot set', () => {
  assert.strictEqual(O.composeEmail(lead(), slots({ block: '  ' })), null);
  assert.strictEqual(O.composeEmail(lead(), slots({ sector: '' })), null);
  assert.strictEqual(O.composeEmail(lead(), null), null);
});

test('mergeDrafts composes and writes both halves onto the lead, by index', () => {
  const batch = [lead(), lead({ company: 'Other Co' })];
  const n = O.mergeDrafts(batch, [{ index: 1, ...slots() }]);
  assert.strictEqual(n, 1);
  assert.strictEqual(batch[0].outreachSubject, undefined);
  assert.strictEqual(batch[1].outreachSubject, 'Logistics security — worth 15 minutes?');
  assert.match(batch[1].outreachBody, /logistics organisations/);
});

test('mergeDrafts refuses partial slots — backfill must retry instead', () => {
  const batch = [lead(), lead(), lead()];
  const n = O.mergeDrafts(batch, [
    { index: 0, ...slots({ block: '' }) },
    { index: 1, ...slots({ services: '   ' }) },
    { index: 2, ...slots() },
  ]);
  assert.strictEqual(n, 1);
  assert.strictEqual(batch[0].outreachSubject, undefined);
  assert.strictEqual(batch[1].outreachSubject, undefined);
  assert.ok(batch[2].outreachSubject);
});

test('mergeDrafts tolerates a missing or empty response', () => {
  const batch = [lead()];
  assert.strictEqual(O.mergeDrafts(batch, null), 0);
  assert.strictEqual(O.mergeDrafts(batch, []), 0);
  assert.strictEqual(batch[0].outreachSubject, undefined);
});

test('the tool schema requires index and all three slots', () => {
  const item = O.TOOL.input_schema.properties.drafts.items;
  assert.deepStrictEqual(item.required.sort(), ['block', 'index', 'sector', 'services']);
});
