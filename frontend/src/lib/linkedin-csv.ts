/**
 * LinkedIn Lead Gen Form CSV exports (Page → Analytics → Leads, or Campaign
 * Manager → Lead Gen Forms → Download) → Zoho Lead payloads. Pure; the importer
 * script does the I/O. Header names vary by export, so they are matched loosely.
 */
import type { LeadPayload } from './zoho-leads';

export interface LinkedInCsvRow {
  leadId: string; firstName: string; lastName: string; email: string; company: string; jobTitle: string;
  phone: string; country: string; formName: string; submittedAt: string; extra: Record<string, string>;
}

const HEADERS: Record<keyof Omit<LinkedInCsvRow, 'extra'>, RegExp> = {
  leadId: /^lead ?id$/i,
  firstName: /^first ?name$/i,
  lastName: /^last ?name$/i,
  email: /^(e-?mail( address)?|work e-?mail)$/i,
  company: /^company( name)?$/i,
  jobTitle: /^(job )?title$/i,
  phone: /^(phone|mobile)( number)?$/i,
  country: /^country(\/region)?$/i,
  formName: /^form( name)?$/i,
  submittedAt: /^(lead )?submitted at/i,
};

/** Minimal RFC 4180 reader: quotes, doubled quotes, embedded commas/newlines, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

export function parseLinkedInCsv(text: string): LinkedInCsvRow[] {
  const [header, ...lines] = parseCsv(text);
  if (!header) return [];
  const idx: Partial<Record<keyof LinkedInCsvRow, number>> = {};
  const extraCols: number[] = [];
  header.forEach((h, i) => {
    const name = h.trim();
    const key = (Object.keys(HEADERS) as (keyof typeof HEADERS)[]).find((k) => HEADERS[k].test(name));
    if (key && idx[key] === undefined) idx[key] = i; else extraCols.push(i);
  });
  const get = (line: string[], k: keyof typeof HEADERS) => (idx[k] === undefined ? '' : (line[idx[k]!] || '').trim());
  const out: LinkedInCsvRow[] = [];
  for (const line of lines) {
    const email = get(line, 'email').toLowerCase();
    if (!email || !email.includes('@')) continue;
    const extra: Record<string, string> = {};
    for (const i of extraCols) { const v = (line[i] || '').trim(); if (v) extra[header[i].trim()] = v; }
    out.push({ leadId: get(line, 'leadId'), firstName: get(line, 'firstName'), lastName: get(line, 'lastName'), email, company: get(line, 'company'), jobTitle: get(line, 'jobTitle'), phone: get(line, 'phone'), country: get(line, 'country'), formName: get(line, 'formName'), submittedAt: get(line, 'submittedAt'), extra });
  }
  return out;
}

const cut = (s: string, n: number) => s.slice(0, n);

export function buildLinkedInLead(r: LinkedInCsvRow, ownerId: string): LeadPayload {
  const last = r.lastName || r.firstName || 'Unknown';
  const insert: Record<string, unknown> = {
    Last_Name: cut(last, 80),
    Email: r.email,
    Company: cut(r.company || 'Unknown', 200),
    Lead_Source: 'LinkedIn',
    Lead_Status: 'Not Contacted',
    Email_Opt_Out: false,
    ...(ownerId ? { Owner: { id: ownerId } } : {}),
    Tag: [{ name: 'linkedin' }],
    UTM_Source: 'linkedin',
    UTM_Medium: 'lead-gen-form',
  };
  if (r.lastName && r.firstName) insert.First_Name = cut(r.firstName, 40);
  if (r.jobTitle) insert.Designation = cut(r.jobTitle, 100);
  if (r.phone) insert.Phone = cut(r.phone, 30);
  if (r.formName) insert.UTM_Campaign = cut(r.formName, 200);
  const lines = [
    r.formName ? `Form: ${r.formName}` : null,
    r.submittedAt ? `Submitted: ${r.submittedAt} (UTC)` : null,
    r.country ? `Country: ${r.country}` : null,
    r.leadId ? `LinkedIn lead id: ${r.leadId}` : null,
    ...Object.entries(r.extra).map(([k, v]) => `${k}: ${v}`),
  ].filter(Boolean);
  if (lines.length) insert.Description = cut(lines.join('\n'), 32000);

  const update: Record<string, unknown> = {};
  if (r.lastName && r.firstName) { update.First_Name = insert.First_Name; update.Last_Name = insert.Last_Name; }
  else if (r.firstName || r.lastName) update.Last_Name = insert.Last_Name;
  if (r.company) update.Company = insert.Company;
  if (r.jobTitle) update.Designation = insert.Designation;
  if (r.phone) update.Phone = insert.Phone;
  return { insert, update, tags: ['linkedin'] };
}
