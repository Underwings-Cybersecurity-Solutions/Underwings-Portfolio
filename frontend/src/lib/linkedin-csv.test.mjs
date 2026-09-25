import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinkedInCsv, buildLinkedInLead } from './linkedin-csv.ts';

const csv = `Lead Id,First Name,Last Name,Email Address,Company Name,Job Title,Phone Number,Country/Region,Form Name,Lead Submitted At (UTC),What can we help with?
"urn:li:lead:1","Sara","Al Marri","Sara@GulfCo.ae","Gulf Co, LLC","IT Manager","+971 50 111 2222","United Arab Emirates","Free Security Assessment","2026-09-25 07:15:00","We need a pentest before ""Q4"""
"urn:li:lead:2","Omar","","omar@example.ae","","","","","Free Security Assessment","2026-09-25 07:20:00",""
`;

test('parses LinkedIn export headers into normalised fields, handling quotes and commas', () => {
  const rows = parseLinkedInCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { leadId: 'urn:li:lead:1', firstName: 'Sara', lastName: 'Al Marri', email: 'sara@gulfco.ae', company: 'Gulf Co, LLC', jobTitle: 'IT Manager', phone: '+971 50 111 2222', country: 'United Arab Emirates', formName: 'Free Security Assessment', submittedAt: '2026-09-25 07:15:00', extra: { 'What can we help with?': 'We need a pentest before "Q4"' } });
  assert.equal(rows[1].lastName, '');
  assert.equal(rows[1].email, 'omar@example.ae');
});

test('ignores rows without an email and tolerates BOM / CRLF / unknown header order', () => {
  const rows = parseLinkedInCsv('﻿Email Address,First Name\r\n,NoEmail\r\nx@y.co,Has\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'x@y.co');
  assert.equal(rows[0].firstName, 'Has');
});

test('buildLinkedInLead: insert has LinkedIn source, tags and campaign; update is the safe subset', () => {
  const [row] = parseLinkedInCsv(csv);
  const p = buildLinkedInLead(row, 'o1');
  assert.equal(p.insert.Lead_Source, 'LinkedIn');
  assert.equal(p.insert.First_Name, 'Sara'); assert.equal(p.insert.Last_Name, 'Al Marri');
  assert.equal(p.insert.Email, 'sara@gulfco.ae'); assert.equal(p.insert.Company, 'Gulf Co, LLC'); assert.equal(p.insert.Designation, 'IT Manager'); assert.equal(p.insert.Phone, '+971 50 111 2222');
  assert.equal(p.insert.UTM_Source, 'linkedin'); assert.equal(p.insert.UTM_Medium, 'lead-gen-form'); assert.equal(p.insert.UTM_Campaign, 'Free Security Assessment');
  assert.match(p.insert.Description, /We need a pentest before "Q4"/);
  assert.match(p.insert.Description, /Form: Free Security Assessment/);
  assert.equal(p.insert.Lead_Status, 'Not Contacted'); assert.deepEqual(p.insert.Owner, { id: 'o1' });
  assert.deepEqual(p.tags, ['linkedin']);
  assert.deepEqual(Object.keys(p.update).sort(), ['Company', 'Designation', 'First_Name', 'Last_Name', 'Phone']);
});

test('buildLinkedInLead: missing last name falls back to first name, missing company to Unknown, nothing safe to update', () => {
  const [, row] = parseLinkedInCsv(csv);
  const p = buildLinkedInLead(row, 'o1');
  assert.equal(p.insert.Last_Name, 'Omar'); assert.ok(!('First_Name' in p.insert)); assert.equal(p.insert.Company, 'Unknown');
  assert.deepEqual(Object.keys(p.update), ['Last_Name']);
});
