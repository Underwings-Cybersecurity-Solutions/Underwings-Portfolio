/**
 * LinkedIn ad leads arrive in Zoho CRM through Zoho's LinkedIn Lead Gen Forms
 * integration (owner-connected). This module mirrors them onto our side so the
 * team gets the same alert and database record as for a website enquiry.
 * Pure helpers here; I/O lives in pages/api/admin/linkedin-sync.ts.
 */
export interface ZohoLeadRow {
  id: string; First_Name?: string | null; Last_Name?: string | null; Email?: string | null; Phone?: string | null;
  Company?: string | null; Designation?: string | null; Lead_Source?: string | null; Created_Time?: string | null;
  UTM_Campaign?: string | null; Description?: string | null; Tag?: { name: string }[] | null;
}

export const LINKEDIN_FIELDS = 'First_Name,Last_Name,Email,Phone,Company,Designation,Lead_Source,Created_Time,UTM_Campaign,Description,Tag';

export function isLinkedInLead(l: ZohoLeadRow): boolean {
  const src = String(l.Lead_Source || '').toLowerCase();
  if (src.includes('linkedin')) return true;
  return (l.Tag || []).some((t) => String(t?.name || '').toLowerCase() === 'linkedin');
}

/** Records list (not COQL: COQL cannot return Tag). Newest first, one page of 200. */
export function recentLeadsPath(): string {
  return `/crm/v7/Leads?fields=${LINKEDIN_FIELDS}&sort_by=Created_Time&sort_order=desc&per_page=200`;
}

export function isRecent(l: ZohoLeadRow, sinceIso: string): boolean {
  const t = Date.parse(String(l.Created_Time || ''));
  return Number.isFinite(t) && t >= Date.parse(sinceIso);
}

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function leadToSubmission(l: ZohoLeadRow) {
  const name = [s(l.First_Name), s(l.Last_Name)].filter(Boolean).join(' ') || 'Unknown';
  return {
    form_type: 'linkedin_ad',
    name,
    email: s(l.Email) ? String(l.Email).trim().toLowerCase() : null,
    phone: s(l.Phone),
    company: s(l.Company),
    job_title: s(l.Designation),
    message: s(l.Description),
    how_heard: s(l.Lead_Source) || 'LinkedIn',
    status: 'new',
    zoho_lead_id: String(l.id),
    zoho_synced_at: new Date().toISOString(),
    metadata: { source: 'zoho-linkedin-sync', campaign: s(l.UTM_Campaign), zoho_created_time: s(l.Created_Time) },
  };
}
