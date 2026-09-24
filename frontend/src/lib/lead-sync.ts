/**
 * Upsert a website lead into Zoho CRM and record the outcome on the Supabase
 * row (zoho_lead_id / zoho_synced_at / zoho_error). Best-effort: never throws,
 * never changes the visitor's response. A repeat submission (Zoho "update")
 * gets a dated Note so history is kept instead of overwritten.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { zoho, type UpsertResult } from './zoho';
import { repeatNote, type WebsiteForm } from './zoho-leads';

export type LeadTable = 'form_submissions' | 'waitlist_signups' | 'subscribers';

export async function syncLead(args: { supabase: SupabaseClient | null; table: LeadTable; recordId: string; lead: Record<string, unknown>; form: WebsiteForm; repeatDetails: string }): Promise<UpsertResult> {
  const { supabase, table, recordId, lead, form, repeatDetails } = args;
  const result = await zoho.upsertLead(lead);
  if (result.ok) {
    console.log(`[zoho] ${table} ${recordId} → ${result.id} (${result.action})`);
    if (result.action === 'update') await zoho.addNote(result.id, `Website: repeat ${form}`, repeatNote(form, repeatDetails));
  } else if (!result.skipped) {
    console.error(`[zoho] ${table} ${recordId} FAILED: ${result.error}`);
  }
  if (supabase && !(result.ok === false && result.skipped)) {
    const patch = result.ok
      ? { zoho_lead_id: result.id, zoho_synced_at: new Date().toISOString(), zoho_error: null }
      : { zoho_error: result.error.slice(0, 1000) };
    const { error } = await supabase.from(table).update(patch).eq('id', recordId);
    if (error) console.error(`[zoho] ${table} ${recordId} write-back failed: ${error.message}`);
  }
  return result;
}
