import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitName, normaliseEmail, buildContactLead, buildWaitlistLead, buildNewsletterLead, repeatNote, FIELD } from './zoho-leads.ts';

const OWNER = '7626271000000625001';

test('splitName: two words, one word, empty', () => {
  assert.deepEqual(splitName('Fatima Al Mansoori'), { First_Name: 'Fatima', Last_Name: 'Al Mansoori' });
  assert.deepEqual(splitName('Fatima'), { Last_Name: 'Fatima' });
  assert.deepEqual(splitName(''), { Last_Name: 'Unknown' });
  assert.deepEqual(splitName(null), { Last_Name: 'Unknown' });
  assert.equal(splitName('A'.repeat(100) + ' ' + 'B'.repeat(100)).Last_Name.length, 80);
});

test('normaliseEmail trims and lowercases', () => {
  assert.equal(normaliseEmail('  Ahmed@Example.COM '), 'ahmed@example.com');
});

test('contact lead: full mapping, message in Description, service in Service_Interest', () => {
  const lead = buildContactLead({
    name: 'Ahmed Khan', email: 'Ahmed@Example.com', phone: '+971 50 123 4567', company: 'ACME LLC',
    service: 'ptaas', message: 'We need a pentest before Q4.', recordId: 'uuid-1',
    attribution: { utm_source: 'linkedin', landing_page: '/services/ptaas', conversion_page: '/', referrer: 'https://www.linkedin.com/' },
  }, OWNER).insert;
  assert.equal(lead.First_Name, 'Ahmed');
  assert.equal(lead.Last_Name, 'Khan');
  assert.equal(lead.Email, 'ahmed@example.com');
  assert.equal(lead.Phone, '+971 50 123 4567');
  assert.equal(lead.Company, 'ACME LLC');
  assert.equal(lead.Lead_Source, 'Website');
  assert.equal(lead.Lead_Status, 'Not Contacted');
  assert.equal(lead.Description, 'We need a pentest before Q4.');
  assert.equal(lead[FIELD.serviceInterest], 'ptaas');
  assert.equal(lead[FIELD.websiteForm], 'Contact');
  assert.equal(lead[FIELD.utmSource], 'linkedin');
  assert.equal(lead[FIELD.landingPage], 'https://underwings.org/services/ptaas');
  assert.equal(lead[FIELD.conversionPage], 'https://underwings.org/');
  assert.equal(lead[FIELD.referrer], 'https://www.linkedin.com/');
  assert.equal(FIELD.referrer, 'Referrer_URL');
  assert.equal(lead[FIELD.websiteRecordId], 'uuid-1');
  assert.deepEqual(lead.Owner, { id: OWNER });
  assert.equal(lead.Email_Opt_Out, false);
  assert.deepEqual(lead.Tag, [{ name: 'website' }, { name: 'contact-form' }]);
  assert.ok(!('Waitlist_Year' in lead));
});

test('contact lead: missing optionals produce Unknown company and no phone key', () => {
  const lead = buildContactLead({ email: 'x@y.z', recordId: 'r', attribution: {} }, OWNER).insert;
  assert.equal(lead.Company, 'Unknown');
  assert.equal(lead.Last_Name, 'Unknown');
  assert.ok(!('Phone' in lead));
  assert.ok(!('Description' in lead));
});

test('contact lead: phone capped at 30, description at 32000', () => {
  const lead = buildContactLead({ email: 'x@y.z', phone: '1'.repeat(50), message: 'm'.repeat(40000), recordId: 'r', attribution: {} }, OWNER).insert;
  assert.equal(lead.Phone.length, 30);
  assert.equal(lead.Description.length, 32000);
});

test('waitlist lead', () => {
  const lead = buildWaitlistLead({ email: 'w@x.y', serviceSlug: 'soc-mdr', year: '2027', sourcePage: '/services/soc-mdr', recordId: 'w1', attribution: {} }, OWNER).insert;
  assert.equal(lead.Last_Name, 'W');
  assert.equal(lead.Company, 'Unknown');
  assert.equal(lead[FIELD.websiteForm], 'Waitlist');
  assert.equal(lead[FIELD.serviceInterest], 'soc-mdr');
  assert.equal(lead[FIELD.waitlistYear], '2027');
  assert.equal(lead[FIELD.conversionPage], 'https://underwings.org/services/soc-mdr');
  assert.equal(lead.Description, 'Joined the waitlist for soc-mdr (2027) from /services/soc-mdr');
  assert.deepEqual(lead.Tag, [{ name: 'website' }, { name: 'waitlist' }]);
});

test('waitlist lead: name given, no year', () => {
  const lead = buildWaitlistLead({ name: 'Sara Q', company: 'Gulf Co', email: 'w@x.y', serviceSlug: 'dfir', recordId: 'w2', attribution: {} }, OWNER).insert;
  assert.equal(lead.First_Name, 'Sara');
  assert.equal(lead.Company, 'Gulf Co');
  assert.ok(!(FIELD.waitlistYear in lead));
  assert.equal(lead.Description, 'Joined the waitlist for dfir');
});

test('resource download: lead magnet source → Resource Download form + Resource_Downloaded', () => {
  const lead = buildNewsletterLead({ email: 'john.doe@corp.ae', source: 'lead_magnet:Security Assessment Checklist', recordId: 'n1', attribution: { ga_client_id: '123.456' } }, OWNER).insert;
  assert.equal(lead.Last_Name, 'John Doe');
  assert.equal(lead[FIELD.websiteForm], 'Resource Download');
  assert.equal(lead[FIELD.resourceDownloaded], 'Security Assessment Checklist');
  assert.equal(lead.Lead_Status, 'Contact in Future');
  assert.equal(lead.Description, 'Downloaded "Security Assessment Checklist" from the website');
  assert.equal(lead[FIELD.gaClientId], '123.456');
  assert.deepEqual(lead.Tag, [{ name: 'website' }, { name: 'resource-download' }]);
});

test('plain newsletter signup', () => {
  const lead = buildNewsletterLead({ email: 'x@y.z', source: 'newsletter', recordId: 'n2', attribution: {} }, OWNER).insert;
  assert.equal(lead[FIELD.websiteForm], 'Newsletter');
  assert.equal(lead.Lead_Status, 'Contact in Future');
  assert.ok(!(FIELD.resourceDownloaded in lead));
  assert.deepEqual(lead.Tag, [{ name: 'website' }, { name: 'newsletter' }]);
});

test('repeatNote is dated and names the form', () => {
  const n = repeatNote('Contact', 'Service: vapt\nMessage: hi', new Date('2026-09-24T10:00:00Z'));
  assert.match(n, /^Submitted the Contact form again on 24 Sept? 2026/);
  assert.ok(n.endsWith('Service: vapt\nMessage: hi'));
});

// ---- Review fix #1: a repeat submission must never overwrite worked CRM data ----
test('update payload: contact repeat keeps only real form fields, never status/owner/source/opt-out/UTM/Description', () => {
  const p = buildContactLead({ name: 'Ahmed Khan', email: 'a@b.c', phone: '+971 50 000 0000', company: 'ACME', service: 'vapt', message: 'new message', recordId: 'r2',
    attribution: { utm_source: 'x', landing_page: '/l', conversion_page: '/c', referrer: 'https://r/' } }, OWNER);
  assert.deepEqual(Object.keys(p.update).sort(), ['Company', 'Conversion_Page', 'First_Name', 'Last_Name', 'Phone', 'Service_Interest', 'Website_Form', 'Website_Record_ID']);
  assert.equal(p.update.Company, 'ACME');
  assert.deepEqual(p.tags, ['website', 'contact-form']);
  assert.ok(!('Tag' in p.update) && !('Email' in p.update));
});

test('update payload: resource download after a contact enquiry does not downgrade the Lead', () => {
  const p = buildNewsletterLead({ email: 'a@b.c', source: 'lead_magnet:Security Assessment Checklist', recordId: 'n9', attribution: {} }, OWNER);
  assert.deepEqual(Object.keys(p.update).sort(), ['Resource_Downloaded', 'Website_Form', 'Website_Record_ID']);
  assert.ok(!('Last_Name' in p.update), 'derived name must not overwrite a real one');
  assert.ok(!('Company' in p.update), 'placeholder company must not overwrite a real one');
  assert.ok(!('Lead_Status' in p.update));
});

test('update payload: waitlist with a real name and company sends them; without, sends neither', () => {
  const a = buildWaitlistLead({ name: 'Sara Q', company: 'Gulf Co', email: 'w@x.y', serviceSlug: 'dfir', year: '2028', recordId: 'w3', attribution: {} }, OWNER).update;
  assert.equal(a.First_Name, 'Sara'); assert.equal(a.Company, 'Gulf Co'); assert.equal(a.Waitlist_Year, '2028');
  const b = buildWaitlistLead({ email: 'w@x.y', serviceSlug: 'dfir', recordId: 'w4', attribution: {} }, OWNER).update;
  assert.ok(!('Last_Name' in b) && !('Company' in b));
});

test('insert payload still carries Email_Opt_Out=false, Owner, Lead_Status, Tag', () => {
  const p = buildContactLead({ email: 'a@b.c', recordId: 'r', attribution: {} }, OWNER);
  assert.equal(p.insert.Email_Opt_Out, false); assert.deepEqual(p.insert.Owner, { id: OWNER }); assert.equal(p.insert.Lead_Status, 'Not Contacted');
});

// ---- Review fix #5: URL fields are validated, and a bad one drops the field, not the lead ----
test('attribution URLs: invalid or over-long values are dropped per field', () => {
  const p = buildContactLead({ email: 'a@b.c', recordId: 'r', attribution: {
    landing_page: '/ok?x=1', conversion_page: '/a b', referrer: 'https://%2', utm_source: 'fine' } }, OWNER).insert;
  assert.equal(p[FIELD.landingPage], 'https://underwings.org/ok?x=1');
  assert.ok(!(FIELD.conversionPage in p), 'space in path is not a valid URL');
  assert.ok(!(FIELD.referrer in p), 'bad percent-encoding is not a valid URL');
  assert.equal(p[FIELD.utmSource], 'fine');
  const long = buildContactLead({ email: 'a@b.c', recordId: 'r', attribution: { landing_page: '/' + 'x'.repeat(199) } }, OWNER).insert;
  assert.equal(long[FIELD.landingPage], 'https://underwings.org/' + 'x'.repeat(199));
  const tooLong = buildContactLead({ email: 'a@b.c', recordId: 'r', attribution: { referrer: 'https://r.example/' + 'y'.repeat(180) + '/' + 'z'.repeat(60) } }, OWNER).insert;
  assert.ok(!(FIELD.referrer in tooLong));
});

test('empty ownerId omits Owner instead of sending an empty id', () => {
  const p = buildContactLead({ email: 'a@b.c', recordId: 'r', attribution: {} }, '');
  assert.ok(!('Owner' in p.insert));
});
