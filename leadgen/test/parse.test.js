'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/parse');

test('extractEmails: finds, lowercases, dedupes, drops asset noise', () => {
  const html = 'a Sales@Acme.com b sales@acme.com c logo@2x.png d x@example.com e info@acme.com';
  assert.deepStrictEqual(P.extractEmails(html), ['sales@acme.com', 'info@acme.com']);
});

test('domainOf: strips www and lowercases; bad URL → empty string', () => {
  assert.strictEqual(P.domainOf('https://www.Gucci.com/en/page'), 'gucci.com');
  assert.strictEqual(P.domainOf('not a url'), '');
});

test('parseRssItems: parses title/link/description, strips CDATA and tags', () => {
  const xml = '<rss><item><title><![CDATA[Brand launches <b>leather</b> line]]></title>' +
    '<link>https://ex.com/a</link><description>desc here</description></item></rss>';
  const items = P.parseRssItems(xml);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].title, 'Brand launches leather line');
  assert.strictEqual(items[0].link, 'https://ex.com/a');
});

test('obfuscated addresses are read the way a human reads them', () => {
  const html = `
    <p>Email us: info [at] acme [dot] ae</p>
    <p>sales(at)gulfreach(dot)co(dot)ae</p>
    <p>hr @ example-co . ae</p>
    <p>plain@normal.ae</p>`;
  const got = P.extractEmails(html);
  assert.ok(got.includes('info@acme.ae'));
  assert.ok(got.includes('sales@gulfreach.co.ae'));
  assert.ok(got.includes('hr@example-co.ae'));
  assert.ok(got.includes('plain@normal.ae'), 'plain addresses must still work');
});

test('deobfuscation does not invent addresses out of prose', () => {
  // "at" and "dot" appear in ordinary text constantly; a match needs a real
  // TLD-shaped tail or every sentence becomes an email
  assert.deepStrictEqual(P.deobfuscateEmails('meet me at the office'), []);
  assert.deepStrictEqual(P.deobfuscateEmails('look at that'), []);
  assert.deepStrictEqual(P.deobfuscateEmails(''), []);
  assert.deepStrictEqual(P.deobfuscateEmails(null), []);
});

test('extractEmails still dedupes and drops asset noise after deobfuscation', () => {
  const got = P.extractEmails('a [at] b [dot] ae and a@b.ae and logo@x.png');
  assert.deepStrictEqual(got, ['a@b.ae']);
});

test('normCompany folds UAE legal suffixes so one company is one prospect', () => {
  assert.strictEqual(P.normCompany('Wio Bank P.J.S.C.'), P.normCompany('WIO Bank'));
  assert.strictEqual(P.normCompany('Omega Insurance Brokers LLC'), P.normCompany('Omega Insurance Brokers'));
  assert.strictEqual(P.normCompany('Acme Trading FZE'), P.normCompany('Acme Trading'));
  assert.strictEqual(P.normCompany('Gulf Co. Ltd'), P.normCompany('Gulf'));
});

test('normCompany never merges two different companies', () => {
  assert.notStrictEqual(P.normCompany('Emirates NBD'), P.normCompany('Emirates Airlines'));
  assert.notStrictEqual(P.normCompany('Gulf Business Machines'), P.normCompany('Gulf Business'));
  assert.notStrictEqual(P.normCompany('Al Shafar'), P.normCompany('Al Ansari'));
});

test('normCompany degrades safely rather than returning an empty key', () => {
  // a company literally called "Holdings" must still get a key, or every
  // such lead collides on ''
  assert.ok(P.normCompany('Holdings').length > 0);
  assert.ok(P.normCompany('LLC').length > 0);
  assert.strictEqual(P.normCompany(''), '');
  assert.strictEqual(P.normCompany(null), '');
});
