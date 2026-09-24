/**
 * Pure mappers: website form data → Zoho CRM Lead payload.
 * No I/O here so the mapping is unit-testable. FIELD holds the custom field
 * API names created on 2026-09-24 (see docs/runbooks/zoho-crm-website.md);
 * if Zoho ever generates a different name, change it in one place.
 */
import type { Attribution } from './attribution';

export const FIELD = {
  websiteForm: 'Website_Form',
  serviceInterest: 'Service_Interest',
  resourceDownloaded: 'Resource_Downloaded',
  waitlistYear: 'Waitlist_Year',
  utmSource: 'UTM_Source',
  utmMedium: 'UTM_Medium',
  utmCampaign: 'UTM_Campaign',
  utmTerm: 'UTM_Term',
  utmContent: 'UTM_Content',
  landingPage: 'Landing_Page',
  conversionPage: 'Conversion_Page',
  referrer: 'Referrer_URL', // Zoho rejects the label "Referrer" (system keyword)
  gaClientId: 'GA_Client_ID',
  websiteRecordId: 'Website_Record_ID',
} as const;

const SITE = 'https://underwings.org';
const LIMITS = { first: 40, last: 80, company: 200, phone: 30, description: 32000, text: 200 };

export type WebsiteForm = 'Contact' | 'Waitlist' | 'Newsletter' | 'Resource Download';
export interface ContactInput { name?: string | null; email: string; phone?: string | null; company?: string | null; service?: string | null; message?: string | null; recordId: string; attribution: Attribution }
export interface WaitlistInput { name?: string | null; email: string; company?: string | null; serviceSlug: string; year?: string | null; sourcePage?: string | null; recordId: string; attribution: Attribution }
export interface NewsletterInput { email: string; source: string; recordId: string; attribution: Attribution }

const cut = (s: string, n: number) => s.slice(0, n);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function normaliseEmail(e: string): string { return e.trim().toLowerCase(); }

export function splitName(full: string | null | undefined): { First_Name?: string; Last_Name: string } {
  const s = str(full);
  if (!s) return { Last_Name: 'Unknown' };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { Last_Name: cut(parts[0], LIMITS.last) };
  return { First_Name: cut(parts[0], LIMITS.first), Last_Name: cut(parts.slice(1).join(' '), LIMITS.last) };
}

function nameFromEmail(email: string): string {
  const local = email.split('@')[0] || 'Unknown';
  return cut(local.replace(/[._+-]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || 'Unknown', LIMITS.last);
}

function absolute(p: string | undefined): string | undefined {
  if (!p) return undefined;
  return p.startsWith('/') ? SITE + p : p;
}

function attributionFields(a: Attribution): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (a.utm_source) out[FIELD.utmSource] = cut(a.utm_source, LIMITS.text);
  if (a.utm_medium) out[FIELD.utmMedium] = cut(a.utm_medium, LIMITS.text);
  if (a.utm_campaign) out[FIELD.utmCampaign] = cut(a.utm_campaign, LIMITS.text);
  if (a.utm_term) out[FIELD.utmTerm] = cut(a.utm_term, LIMITS.text);
  if (a.utm_content) out[FIELD.utmContent] = cut(a.utm_content, LIMITS.text);
  if (a.landing_page) out[FIELD.landingPage] = absolute(a.landing_page);
  if (a.conversion_page) out[FIELD.conversionPage] = absolute(a.conversion_page);
  if (a.referrer) out[FIELD.referrer] = a.referrer;
  if (a.ga_client_id) out[FIELD.gaClientId] = cut(a.ga_client_id, 100);
  return out;
}

function base(form: WebsiteForm, tag: string, email: string, recordId: string, ownerId: string, a: Attribution): Record<string, unknown> {
  return {
    Email: normaliseEmail(email),
    Lead_Source: 'Website',
    Lead_Status: 'Not Contacted',
    Email_Opt_Out: false,
    Owner: { id: ownerId },
    Tag: [{ name: 'website' }, { name: tag }],
    [FIELD.websiteForm]: form,
    [FIELD.websiteRecordId]: cut(recordId, 64),
    ...attributionFields(a),
  };
}

export function buildContactLead(i: ContactInput, ownerId: string): Record<string, unknown> {
  const lead = { ...base('Contact', 'contact-form', i.email, i.recordId, ownerId, i.attribution), ...splitName(i.name) };
  lead.Company = cut(str(i.company) || 'Unknown', LIMITS.company);
  const phone = str(i.phone); if (phone) lead.Phone = cut(phone, LIMITS.phone);
  const service = str(i.service); if (service) lead[FIELD.serviceInterest] = cut(service, LIMITS.text);
  const message = str(i.message); if (message) lead.Description = cut(message, LIMITS.description);
  return lead;
}

export function buildWaitlistLead(i: WaitlistInput, ownerId: string): Record<string, unknown> {
  const lead = base('Waitlist', 'waitlist', i.email, i.recordId, ownerId, i.attribution);
  Object.assign(lead, str(i.name) ? splitName(i.name) : { Last_Name: nameFromEmail(normaliseEmail(i.email)) });
  lead.Company = cut(str(i.company) || 'Unknown', LIMITS.company);
  lead[FIELD.serviceInterest] = cut(i.serviceSlug, LIMITS.text);
  const year = str(i.year); if (year) lead[FIELD.waitlistYear] = year;
  const page = str(i.sourcePage);
  if (page && !lead[FIELD.conversionPage]) lead[FIELD.conversionPage] = absolute(page);
  lead.Description = `Joined the waitlist for ${i.serviceSlug}` + (year ? ` (${year})` : '') + (page ? ` from ${page}` : '');
  return lead;
}

export function buildNewsletterLead(i: NewsletterInput, ownerId: string): Record<string, unknown> {
  // source is 'newsletter' or 'lead_magnet:<resource name>' (set by api/newsletter.ts)
  const magnet = i.source.startsWith('lead_magnet:') ? i.source.slice('lead_magnet:'.length).trim() : null;
  const lead = magnet
    ? base('Resource Download', 'resource-download', i.email, i.recordId, ownerId, i.attribution)
    : base('Newsletter', 'newsletter', i.email, i.recordId, ownerId, i.attribution);
  lead.Last_Name = nameFromEmail(normaliseEmail(i.email));
  lead.Company = 'Unknown';
  // Marketing leads are nurtured, not called: keep them out of the "Not Contacted" queue.
  lead.Lead_Status = 'Contact in Future';
  if (magnet) {
    lead[FIELD.resourceDownloaded] = cut(magnet, LIMITS.text);
    lead.Description = `Downloaded "${cut(magnet, LIMITS.text)}" from the website`;
  } else {
    lead.Description = 'Newsletter signup from the website';
  }
  return lead;
}

export function repeatNote(form: WebsiteForm, details: string, when: Date = new Date()): string {
  const date = when.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Submitted the ${form} form again on ${date} (Dubai)\n\n${details}`;
}
