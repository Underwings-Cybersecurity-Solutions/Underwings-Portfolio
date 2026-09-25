import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLinkedInLead, leadToSubmission, recentLeadsQuery } from './linkedin-leads.ts';

const lead = { id: '7626271000000800001', First_Name: 'Sara', Last_Name: 'Al Marri', Email: 'Sara@Gulfco.ae', Phone: '+971 50 111 2222', Company: 'Gulf Co', Designation: 'IT Manager', Lead_Source: 'LinkedIn Lead Gen Forms', Created_Time: '2026-09-25T08:15:00+04:00', UTM_Campaign: 'Q4 VAPT UAE', Description: 'Interested in a pentest', Tag: [{ name: 'linkedin' }] };

test('isLinkedInLead: by source text (any casing) or by tag; website leads never match', () => {
  assert.equal(isLinkedInLead(lead), true);
  assert.equal(isLinkedInLead({ ...lead, Lead_Source: 'linkedin', Tag: [] }), true);
  assert.equal(isLinkedInLead({ ...lead, Lead_Source: 'Advertisement', Tag: [{ name: 'LinkedIn' }] }), true);
  assert.equal(isLinkedInLead({ ...lead, Lead_Source: 'Website', Tag: [{ name: 'website' }] }), false);
  assert.equal(isLinkedInLead({ ...lead, Lead_Source: null, Tag: null }), false);
});

test('leadToSubmission maps to the form_submissions row and normalises the email', () => {
  const row = leadToSubmission(lead);
  assert.equal(row.form_type, 'linkedin_ad');
  assert.equal(row.name, 'Sara Al Marri');
  assert.equal(row.email, 'sara@gulfco.ae');
  assert.equal(row.phone, '+971 50 111 2222');
  assert.equal(row.company, 'Gulf Co');
  assert.equal(row.job_title, 'IT Manager');
  assert.equal(row.message, 'Interested in a pentest');
  assert.equal(row.how_heard, 'LinkedIn Lead Gen Forms');
  assert.equal(row.status, 'new');
  assert.equal(row.zoho_lead_id, '7626271000000800001');
  assert.equal(row.metadata.source, 'zoho-linkedin-sync');
  assert.equal(row.metadata.campaign, 'Q4 VAPT UAE');
  assert.equal(row.metadata.zoho_created_time, '2026-09-25T08:15:00+04:00');
});

test('leadToSubmission copes with missing name, email and company', () => {
  const row = leadToSubmission({ id: '1', Last_Name: 'Unknown' });
  assert.equal(row.name, 'Unknown');
  assert.equal(row.email, null);
  assert.equal(row.company, null);
  assert.equal(row.message, null);
});

test('recentLeadsQuery asks Zoho for the fields the mirror needs, newest first, bounded by a date', () => {
  const q = recentLeadsQuery('2026-09-22T00:00:00+00:00');
  assert.match(q, /^select id, First_Name, Last_Name, Email, Phone, Company, Designation, Lead_Source, Created_Time, UTM_Campaign, Description from Leads where Created_Time >= '2026-09-22T00:00:00\+00:00' order by Created_Time desc limit 200$/);
});
