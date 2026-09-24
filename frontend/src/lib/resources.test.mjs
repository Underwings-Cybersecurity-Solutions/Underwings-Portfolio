import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resourceFor } from './resources.ts';

test('matches the exit-popup title case-insensitively and by slug', () => {
  const r = resourceFor('Security Assessment Checklist');
  assert.equal(r.slug, 'security-assessment-checklist');
  assert.equal(r.url, 'https://underwings.org/resources/underwings-security-assessment-checklist.pdf');
  assert.equal(resourceFor(' security assessment checklist ').slug, 'security-assessment-checklist');
  assert.equal(resourceFor('security-assessment-checklist').slug, 'security-assessment-checklist');
});

test('unknown or empty → null', () => {
  assert.equal(resourceFor('iso-readiness-checklist'), null);
  assert.equal(resourceFor(''), null);
  assert.equal(resourceFor(undefined), null);
});
