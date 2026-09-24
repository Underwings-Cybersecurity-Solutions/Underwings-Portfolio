// ============================================================
// POST /api/waitlist
// Captures Coming Soon waitlist signups for Y2/Y3 services.
// Writes to Supabase `waitlist_signups` table with rate limiting
// and basic abuse protection. Optional Listmonk sync.
// ============================================================

import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { notifyTeam, dubaiTime } from '../../lib/team-notify';
import { parseAttribution } from '../../lib/attribution';
import { buildWaitlistLead } from '../../lib/zoho-leads';
import { syncLead } from '../../lib/lead-sync';
import { zoho } from '../../lib/zoho';

export const prerender = false;

const supabaseUrl          = import.meta.env.PUBLIC_SUPABASE_URL         || process.env.PUBLIC_SUPABASE_URL;
const supabaseServiceKey   = import.meta.env.SUPABASE_SERVICE_ROLE_KEY   || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey      = import.meta.env.PUBLIC_SUPABASE_ANON_KEY    || process.env.PUBLIC_SUPABASE_ANON_KEY;

const supabase = supabaseUrl && (supabaseServiceKey || supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey)
  : null;

// Whitelist of accepted service slugs — every Y2 and Y3 service on the site.
// Keep in sync with category hub pages. Unknown slugs are rejected.
const VALID_SERVICE_SLUGS = new Set<string>([
  // Offensive Security — Y2
  'third-party-vendor-risk', 'managed-vulnerability-management',
  // Offensive Security — Y3
  'red-team-exercises', 'soc-mdr', 'dfir', 'cyber-threat-intelligence', 'ot-ics-security',
  // Cloud Security — Y2
  'aws-cloud-security-assessment',
  // Cloud Security — Y3
  'gcp-cloud-security-assessment', 'cnapp-implementation',
  // Network & Infrastructure — Y2
  'zero-trust-architecture-design', 'network-segmentation-implementation',
  // GRC — Y2
  'incident-response-retainer', 'iso-27701', 'nist-csf-risk-reporting',
  // 'dubai-isr-v2' is the retired slug for what is now 'dubai-isr-v3' — Dubai's
  // current standard is ISR v3. Both stay accepted so waitlist rows captured under
  // the old slug keep validating; the roadmap only ever emits the v3 slug now.
  'pci-dss-v4', 'dubai-isr-v3', 'dubai-isr-v2', 'third-party-risk',
  // GRC — Y3
  'nca-ecc-sama', 'cobit-2019', 'iso-42001', 'dora-nis2',
  // Training & Awareness — Y2
  'awareness-e-learning-platform', 'role-specific-training-tracks',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN    = 254;  // RFC 5321
const MAX_STRING_LEN   = 200;
const MAX_UA_LEN       = 500;

// Simple in-memory rate limiter — sufficient for single-instance deploys.
// For multi-instance, migrate to Redis/Upstash later.
const RATE_LIMIT_WINDOW_MS  = 60 * 60 * 1000;  // 1 hour
const RATE_LIMIT_MAX        = 5;                // 5 signups per IP-hash per hour
const rateLimitMap          = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(ipHash: string): boolean {
  const now   = Date.now();
  const entry = rateLimitMap.get(ipHash);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ipHash, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}

// Periodic cleanup of stale rate-limit entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap.entries()) {
    if (now - v.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(k);
  }
}, 10 * 60 * 1000).unref?.();

function hashIp(ip: string): string {
  const salt = process.env.IP_HASH_SALT || 'underwings-waitlist-salt';
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

function sanitize(value: unknown, max = MAX_STRING_LEN): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : null;
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // 1 — Parse and validate JSON body
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // 2 — Extract + validate required fields
  const serviceSlug = sanitize(body.service_slug, 100);
  const emailRaw    = sanitize(body.email, MAX_EMAIL_LEN);
  const serviceYear = sanitize(body.year, 10);
  const sourcePage  = sanitize(body.source_page, MAX_STRING_LEN);
  const name        = sanitize(body.name, MAX_STRING_LEN);
  const company     = sanitize(body.company, MAX_STRING_LEN);
  const attribution = parseAttribution(body.attribution);

  if (!serviceSlug || !VALID_SERVICE_SLUGS.has(serviceSlug)) {
    return json({ error: 'Unknown service' }, 400);
  }
  if (!emailRaw || !EMAIL_RE.test(emailRaw)) {
    return json({ error: 'Valid email required' }, 400);
  }
  if (serviceYear && serviceYear !== '2027' && serviceYear !== '2028') {
    return json({ error: 'Invalid year' }, 400);
  }

  const email = emailRaw.toLowerCase();

  // 3 — Rate limiting per hashed IP
  const rawIp      = (request.headers.get('x-forwarded-for') || clientAddress || 'unknown').split(',')[0].trim();
  const ipHash     = hashIp(rawIp);

  if (!checkRateLimit(ipHash)) {
    return json({ error: 'Too many signups recently' }, 429);
  }

  // 4 — Supabase insert (handle unique conflict as success)
  if (!supabase) {
    // Graceful degradation — Supabase not configured in this env
    console.warn('[waitlist] Supabase not configured; signup not persisted:', { email, serviceSlug });
    return json({ ok: true, persisted: false }, 200);
  }

  const userAgent = sanitize(request.headers.get('user-agent'), MAX_UA_LEN);

  const { data: row, error } = await supabase
    .from('waitlist_signups')
    .insert({
      service_slug:  serviceSlug,
      service_year:  serviceYear,
      email,
      name,
      company,
      source_page:   sourcePage,
      user_agent:    userAgent,
      ip_hash:       ipHash,
      attribution:   Object.keys(attribution).length ? attribution : null,
    })
    .select('id')
    .single();

  if (error) {
    // 23505 = unique_violation (already on waitlist for this service) → still a success from UX perspective
    if ((error as any).code === '23505') {
      return json({ ok: true, already_registered: true }, 200);
    }
    console.error('[waitlist] Supabase insert error:', error.message || JSON.stringify(error));
    return json({ error: 'Signup failed' }, 500);
  }

  // Fire-and-forget team notification — same recipients as the contact form.
  const label = `${serviceSlug}${serviceYear ? ' (' + serviceYear + ')' : ''}`;
  const time = dubaiTime();
  notifyTeam({
    subject: `New waitlist signup: ${label} — ${email}`,
    html: `<p><strong>New waitlist signup</strong> — ${time}</p><p>Email: ${email}<br>Service: ${label}${name ? '<br>Name: ' + name : ''}${company ? '<br>Company: ' + company : ''}${sourcePage ? '<br>Source page: ' + sourcePage : ''}</p><p><a href="https://underwings.org/admin/">Open the admin console</a></p>`,
    text: `New waitlist signup — ${time}\nEmail: ${email}\nService: ${label}${name ? '\nName: ' + name : ''}${company ? '\nCompany: ' + company : ''}${sourcePage ? '\nSource page: ' + sourcePage : ''}\n\nAdmin console: https://underwings.org/admin/`,
    replyTo: email,
  });

  // Zoho CRM: best-effort and NOT awaited — the visitor's response never waits on Zoho
      // (review finding #3: three 8 s calls could push past nginx's 30 s proxy timeout).
  if (row?.id) {
    const recordId = String(row.id);
    void syncLead({
      supabase, table: 'waitlist_signups', recordId, form: 'Waitlist',
      payload: buildWaitlistLead({ name, company, email, serviceSlug, year: serviceYear, sourcePage, recordId, attribution }, zoho.ownerId),
      repeatDetails: `Waitlist: ${label}${sourcePage ? `\nPage: ${sourcePage}` : ''}`,
    });
  }

  return json({ ok: true, already_registered: false }, 200);
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
