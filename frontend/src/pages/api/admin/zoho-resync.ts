/**
 * POST /api/admin/zoho-resync — re-push website rows that never reached Zoho
 * (zoho_lead_id IS NULL). Run nightly by scripts/zoho-resync.sh from inside the
 * container; protected by a shared secret header, never by a session.
 */
import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { zoho } from '../../../lib/zoho';
import { syncLead, type LeadTable } from '../../../lib/lead-sync';
import { parseAttribution } from '../../../lib/attribution';
import { buildContactLead, buildWaitlistLead, buildNewsletterLead, type WebsiteForm } from '../../../lib/zoho-leads';

export const prerender = false;

const url = import.meta.env.PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN = process.env.ZOHO_RESYNC_TOKEN;
const LIMIT = 50;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export const POST: APIRoute = async ({ request }) => {
  const given = request.headers.get('x-resync-token') || '';
  if (!TOKEN || !timingSafeEqual(given, TOKEN)) return json({ error: 'Unauthorized' }, 401);
  if (!zoho.enabled) return json({ error: 'zoho not configured' }, 503);
  if (!url || !key) return json({ error: 'supabase not configured' }, 503);
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const out = { scanned: 0, synced: 0, failed: 0, failures: [] as { table: string; id: string; error: string }[] };

  const run = async (table: LeadTable, form: WebsiteForm, toLead: (r: any) => Record<string, unknown>) => {
    const { data, error } = await supabase.from(table).select('*').is('zoho_lead_id', null).limit(LIMIT);
    if (error) { out.failures.push({ table, id: '-', error: error.message }); return; }
    for (const r of data || []) {
      out.scanned++;
      const res = await syncLead({ supabase, table, recordId: String(r.id), form, lead: toLead(r), repeatDetails: `Back-filled by resync on ${new Date().toISOString()}` });
      if (res.ok) out.synced++; else { out.failed++; out.failures.push({ table, id: String(r.id), error: res.error }); }
    }
  };

  await run('form_submissions', 'Contact', (r) => buildContactLead({ name: r.name, email: r.email, phone: r.phone, company: r.company, service: r.service_interest, message: r.message, recordId: String(r.id), attribution: parseAttribution(r.metadata?.attribution) }, zoho.ownerId));
  await run('waitlist_signups', 'Waitlist', (r) => buildWaitlistLead({ name: r.name, company: r.company, email: r.email, serviceSlug: r.service_slug, year: r.service_year, sourcePage: r.source_page, recordId: String(r.id), attribution: parseAttribution(r.attribution) }, zoho.ownerId));
  await run('subscribers', 'Newsletter', (r) => buildNewsletterLead({ email: r.email, source: r.subscription_source || 'newsletter', recordId: String(r.id), attribution: parseAttribution(r.attribution) }, zoho.ownerId));

  console.log(`[zoho] resync: scanned=${out.scanned} synced=${out.synced} failed=${out.failed}`);
  return json(out, out.failed ? 207 : 200);
};
