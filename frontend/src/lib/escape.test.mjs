import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './escape.ts';

test('escapes the five HTML metacharacters', () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert('1')">&`), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
});
test('null, undefined and non-strings become safe strings', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});
test('plain text is unchanged', () => {
  assert.equal(escapeHtml('Ahmed Khan, ACME LLC'), 'Ahmed Khan, ACME LLC');
});
