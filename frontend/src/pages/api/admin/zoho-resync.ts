/**
 * POST /api/admin/zoho-resync — re-push website rows that never reached Zoho
 * (zoho_lead_id IS NULL). Run nightly by scripts/zoho-resync.sh from inside the
 * container; protected by a shared secret header, never by a session.
 */
import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { zoho } from '../../../lib/zoho';
import { syncLead, GIVE_UP_ATTEMPTS, type LeadTable } from '../../../lib/lead-sync';
import { parseAttribution } from '../../../lib/attribution';
import { buildContactLead, buildWaitlistLead, buildNewsletterLead, type WebsiteForm, type LeadPayload } from '../../../lib/zoho-leads';

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

  const run = async (table: LeadTable, toLead: (r: any) => { form: WebsiteForm; payload: LeadPayload }) => {
    let q = supabase.from(table).select('*').is('zoho_lead_id', null).lt('zoho_attempts', GIVE_UP_ATTEMPTS).order('id', { ascending: true }).limit(LIMIT);
    // Never re-create an opted-out subscriber as a fresh marketing lead (review finding #2).
    if (table === 'subscribers') q = q.eq('subscribed', true);
    const { data, error } = await q;
    if (error) { out.failed++; out.failures.push({ table, id: '-', error: `select failed: ${error.message}` }); return; }
    for (const r of data || []) {
      out.scanned++;
      const { form, payload } = toLead(r);
      const res = await syncLead({ supabase, table, recordId: String(r.id), form, payload, attempts: Number(r.zoho_attempts || 0), repeatDetails: `Back-filled by the nightly resync on ${new Date().toISOString()} (original submission ${r.created_at || r.captured_at || 'unknown'})` });
      if (res.ok) out.synced++; else { out.failed++; out.failures.push({ table, id: String(r.id), error: res.error }); }
    }
  };

  await run('form_submissions', (r) => ({ form: 'Contact', payload: buildContactLead({ name: r.name, email: r.email, phone: r.phone, company: r.company, service: r.service_interest, message: r.message, recordId: String(r.id), attribution: parseAttribution(r.metadata?.attribution) }, zoho.ownerId) }));
  await run('waitlist_signups', (r) => ({ form: 'Waitlist', payload: buildWaitlistLead({ name: r.name, company: r.company, email: r.email, serviceSlug: r.service_slug, year: r.service_year, sourcePage: r.source_page, recordId: String(r.id), attribution: parseAttribution(r.attribution) }, zoho.ownerId) }));
  await run('subscribers', (r) => {
    const source = r.subscription_source || 'newsletter';
    return { form: source.startsWith('lead_magnet:') ? 'Resource Download' : 'Newsletter', payload: buildNewsletterLead({ email: r.email, source, recordId: String(r.id), attribution: parseAttribution(r.attribution) }, zoho.ownerId) };
  });

  console.log(`[zoho] resync: scanned=${out.scanned} synced=${out.synced} failed=${out.failed}`);
  // Always 200 with a body: BusyBox wget (the cron caller) discards the body on any non-2xx.
  return json({ ok: out.failed === 0, ...out }, 200);
};
