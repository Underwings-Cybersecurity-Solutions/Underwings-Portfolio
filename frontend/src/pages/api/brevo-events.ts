import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// Brevo delivery webhook → crm_email_event RPC (migration 021). Brevo POSTs
// one JSON object per event (hard_bounce, spam, unsubscribed, …); the RPC
// decides what each event means for CRM state, this endpoint only
// authenticates and forwards. Registered in Brevo as:
//   https://underwings.org/api/brevo-events?token=<BREVO_WEBHOOK_TOKEN>
// Always answers 200 once authenticated — a non-2xx makes Brevo retry for
// hours, and an unknown event type is not an error, just a no-op.

export const prerender = false;

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const SERVICE_KEY = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN = import.meta.env.BREVO_WEBHOOK_TOKEN || process.env.BREVO_WEBHOOK_TOKEN;

const crm = SUPABASE_URL && SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  : null;

function tokenOk(given: string | null): boolean {
  if (!TOKEN || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MAX_EVENTS = 200;

export const POST: APIRoute = async ({ request, url }) => {
  const json = (status: number, body: object) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  if (!TOKEN || !crm) return json(503, { error: 'not configured' });
  if (!tokenOk(url.searchParams.get('token'))) return json(401, { error: 'unauthorized' });

  let body: unknown;
  try { body = await request.json(); } catch { return json(400, { error: 'bad json' }); }

  const events = (Array.isArray(body) ? body : [body]).slice(0, MAX_EVENTS);
  let handled = 0, skipped = 0;
  for (const e of events) {
    const email = typeof (e as any)?.email === 'string' ? (e as any).email : '';
    const event = typeof (e as any)?.event === 'string' ? (e as any).event : '';
    if (!email || !event) { skipped++; continue; }
    const { data, error } = await crm.rpc('crm_email_event', { p_email: email, p_event: event });
    if (error) {
      console.error('[brevo-events] rpc failed:', error.message);
      skipped++;
      continue;
    }
    console.log('[brevo-events]', event, JSON.stringify(data));
    handled++;
  }
  return json(200, { ok: true, handled, skipped });
};
