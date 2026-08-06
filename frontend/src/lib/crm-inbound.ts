/**
 * Inbound form -> CRM.
 *
 * Replaces the old crm-bridge/n8n hop. That chain was: form handler -> HTTP POST
 * to `http://krayin/webhook-inbound` (the crm-bridge container) -> Frappe REST.
 * The bridge and Frappe were both removed, `krayin` no longer resolves, and
 * N8N_INBOUND_URL was not set on the frontend container — so every website lead
 * silently hit the "env not configured; skipping push" branch and never reached
 * the CRM at all.
 *
 * We now write straight to Postgres through the `crm_intake` RPC using the
 * service-role key (already present in the frontend env). The RPC is atomic and
 * idempotent, so a double-submit or a retry cannot fan out duplicate companies
 * or deals.
 *
 * Fire-and-forget: this NEVER throws. A form submission must not fail because
 * the CRM is unhappy — the handler has already emailed the team and written to
 * form_submissions by the time we get here.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const SERVICE_KEY  = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const crm = SUPABASE_URL && SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  : null;

export type InboundSource =
  | 'contact_form'
  | 'scope_builder'
  | 'scope_builder_quiz'
  | 'adhics_readiness_quiz'
  | 'iso27001_gap_quiz'
  | 'newsletter'
  | 'waitlist'
  | 'partners'
  | 'linkedin_manoj' | 'linkedin_nelson' | 'linkedin_vinoth'
  | 'cold_email_manoj' | 'cold_email_nelson' | 'cold_email_vinoth'
  | 'apollo' | 'referral' | 'whatsapp';

export interface InboundPayload {
  source: InboundSource;
  person: {
    name: string;
    email: string;
    phone?: string;
    company?: string;
    job_title?: string;
  };
  title?: string;
  description?: string;
  lead_value?: number;
  activity_note?: string;
  icp_segment_option_id?: number;
  attributes?: Record<string, string | number>;
}

type SourceRule = {
  /** must be one of crm_deals.source's CHECK values */
  dealSource: string;
  motion: 'services' | 'software';
  icp?: 'healthcare' | 'iso' | 'pdpl' | 'other';
  /** true => register the person, but do NOT open a deal */
  contactOnly?: boolean;
};

// Formerly the n8n SOURCE_MAP, then crm-bridge/mapping.js. Now the only copy.
const SOURCE_MAP: Record<InboundSource, SourceRule> = {
  contact_form:          { dealSource: 'web_form',         motion: 'services' },
  scope_builder:         { dealSource: 'quote_intent',     motion: 'services' },
  scope_builder_quiz:    { dealSource: 'quote_intent',     motion: 'services' },
  adhics_readiness_quiz: { dealSource: 'quote_intent',     motion: 'services', icp: 'healthcare' },
  iso27001_gap_quiz:     { dealSource: 'quote_intent',     motion: 'services', icp: 'iso' },
  waitlist:              { dealSource: 'web_form',         motion: 'services' },
  partners:              { dealSource: 'referral_partner', motion: 'services' },
  referral:              { dealSource: 'referral',         motion: 'services' },
  whatsapp:              { dealSource: 'whatsapp',         motion: 'services' },
  apollo:                { dealSource: 'apollo',           motion: 'services' },
  linkedin_manoj:        { dealSource: 'linkedin',         motion: 'services' },
  linkedin_nelson:       { dealSource: 'linkedin',         motion: 'services' },
  linkedin_vinoth:       { dealSource: 'linkedin',         motion: 'services' },
  cold_email_manoj:      { dealSource: 'cold_email',       motion: 'services' },
  cold_email_nelson:     { dealSource: 'cold_email',       motion: 'services' },
  cold_email_vinoth:     { dealSource: 'cold_email',       motion: 'services' },
  // A newsletter signup is not a deal. Registering the contact is enough — the
  // v_crm_contact_signals view surfaces "newsletter subscriber" on whichever
  // deal that person later appears on, without polluting the pipeline.
  newsletter:            { dealSource: 'newsletter',       motion: 'services', contactOnly: true },
};

/** Stable per-day key so a double-click or a retry is a no-op, while a genuine
 *  second enquiry on another day still opens its own deal. */
function externalRef(source: string, email: string, title: string): string {
  const day = new Date().toISOString().slice(0, 10);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `web:${source}:${email.toLowerCase()}:${day}:${slug}`;
}

export async function notifyCrmInbound(payload: InboundPayload): Promise<void> {
  if (!crm) {
    console.warn('[crm-inbound] SUPABASE_URL / SERVICE_ROLE_KEY not configured; skipping push');
    return;
  }
  const rule = SOURCE_MAP[payload.source];
  if (!rule) {
    console.warn(`[crm-inbound] unmapped source "${payload.source}"; skipping push`);
    return;
  }

  const email = (payload.person?.email || '').trim().toLowerCase();
  if (!email) {
    console.warn('[crm-inbound] no email on payload; skipping push');
    return;
  }
  const title = payload.title || `${payload.source} — ${payload.person?.name || email}`;

  // attributes ride along in the description so nothing the form collected is lost
  const extras = payload.attributes
    ? Object.entries(payload.attributes).map(([k, v]) => `${k}: ${v}`).join('\n')
    : '';
  const description = [payload.description || '', extras].filter(Boolean).join('\n\n');

  try {
    const { data, error } = await crm.rpc('crm_intake', {
      payload: {
        company_name:  payload.person?.company || null,
        email,
        contact_name:  payload.person?.name || null,
        phone:         payload.person?.phone || null,
        job_title:     payload.person?.job_title || null,
        title,
        description:   description || null,
        motion:        rule.motion,
        stage:         'new',
        source:        rule.dealSource,
        icp_segment:   rule.icp || null,
        value_aed:     payload.lead_value ?? null,
        activity_note: payload.activity_note || null,
        contact_only:  rule.contactOnly === true,
        external_ref:  externalRef(payload.source, email, title),
      },
    });
    if (error) {
      console.error('[crm-inbound] crm_intake failed:', error.message);
      return;
    }
    const res = (data || {}) as { deal_id?: string; created?: boolean };
    if (rule.contactOnly) {
      console.log(`[crm-inbound] ${payload.source}: contact registered (${email})`);
    } else {
      console.log(`[crm-inbound] ${payload.source}: deal ${res.deal_id}${res.created === false ? ' (existing)' : ''}`);
    }
  } catch (e) {
    console.error('[crm-inbound] push failed:', e);
  }
}
