import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAttribution } from './attribution.ts';

test('keeps only allow-listed string keys', () => {
  const a = parseAttribution({ utm_source: 'linkedin', evil: 'x', utm_medium: 42, referrer: 'https://a.b/' });
  assert.deepEqual(a, { utm_source: 'linkedin', referrer: 'https://a.b/' });
});

test('caps at 200 chars and strips control characters', () => {
  const a = parseAttribution({ utm_campaign: 'a\u0000b\u001fc' + 'x'.repeat(500) });
  assert.equal(a.utm_campaign.length, 200);
  assert.ok(!/[\u0000-\u001f]/.test(a.utm_campaign));
  assert.ok(a.utm_campaign.startsWith('abcx'));
});

test('returns {} for non-objects and drops empty strings', () => {
  assert.deepEqual(parseAttribution(null), {});
  assert.deepEqual(parseAttribution('str'), {});
  assert.deepEqual(parseAttribution([1]), {});
  assert.deepEqual(parseAttribution({ utm_source: '   ' }), {});
});

test('url-ish fields must be a path or http(s) URL', () => {
  const a = parseAttribution({ landing_page: '/services?x=1', referrer: 'javascript:alert(1)', conversion_page: 'https://underwings.org/ar' });
  assert.deepEqual(a, { landing_page: '/services?x=1', conversion_page: 'https://underwings.org/ar' });
});
