/**
 * Put a website lead into Zoho CRM and record the outcome on the Supabase row
 * (zoho_lead_id / zoho_synced_at / zoho_error / zoho_attempts). Best-effort: never
 * throws. Callers fire it AFTER the visitor's response so Zoho latency is invisible.
 *
 * New email  → create the full record.
 * Known email → PATCH only the update-safe subset (payload.update), add the form's
 *               tags, and append a dated Note; sales-owned fields are never touched.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { zoho as defaultClient, type ZohoClient } from './zoho.ts';
import { repeatNote, type LeadPayload, type WebsiteForm } from './zoho-leads.ts';

export type LeadTable = 'form_submissions' | 'waitlist_signups' | 'subscribers';
export type SyncResult =
  | { ok: true; id: string; action: 'insert' | 'update' }
  | { ok: false; skipped?: true; permanent?: true; error: string };

/** After this many failed nights the resync stops retrying a row (see zoho-resync.ts). */
export const GIVE_UP_ATTEMPTS = 5;
const PERMANENT = 99;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function syncLead(args: {
  supabase: SupabaseClient | null; table: LeadTable; recordId: string; payload: LeadPayload;
  form: WebsiteForm; repeatDetails: string; attempts?: number; client?: ZohoClient;
}): Promise<SyncResult> {
  const { supabase, table, recordId, payload, form, repeatDetails } = args;
  const client = args.client ?? defaultClient;
  const attempts = args.attempts ?? 0;
  const email = String(payload.insert.Email || '');

  let result: SyncResult;
  if (!client.enabled) {
    result = { ok: false, skipped: true, error: 'zoho not configured' };
  } else if (!EMAIL_RE.test(email)) {
    result = { ok: false, permanent: true, error: `invalid email: ${email.slice(0, 60)}` };
  } else {
    result = await push(client, payload, form, repeatDetails);
  }

  if (result.ok) console.log(`[zoho] ${table} ${recordId} → ${result.id} (${result.action})`);
  else if (!result.skipped) console.error(`[zoho] ${table} ${recordId} FAILED: ${result.error}`);

  if (supabase && !(result.ok === false && result.skipped)) {
    const patch = result.ok
      ? { zoho_lead_id: result.id, zoho_synced_at: new Date().toISOString(), zoho_error: null }
      : { zoho_error: result.error.slice(0, 1000), zoho_attempts: result.permanent ? PERMANENT : attempts + 1 };
    const { error } = await supabase.from(table).update(patch).eq('id', recordId);
    if (error) console.error(`[zoho] ${table} ${recordId} write-back failed: ${error.message}`);
  }
  return result;
}

async function push(client: ZohoClient, payload: LeadPayload, form: WebsiteForm, repeatDetails: string): Promise<SyncResult> {
  const found = await client.findLeadByEmail(String(payload.insert.Email));
  if (!found.ok) return found;
  if (!found.id) {
    const created = await client.createLead(payload.insert);
    return created.ok ? { ok: true, id: created.id, action: 'insert' } : created;
  }
  if (Object.keys(payload.update).length) {
    const updated = await client.updateLead(found.id, payload.update);
    if (!updated.ok) return updated;
  }
  await client.addTags(found.id, payload.tags);
  await client.addNote(found.id, `Website: repeat ${form}`, repeatNote(form, repeatDetails));
  return { ok: true, id: found.id, action: 'update' };
}
