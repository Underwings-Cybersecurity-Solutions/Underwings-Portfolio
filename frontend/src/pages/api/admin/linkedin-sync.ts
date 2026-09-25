/**
 * POST /api/admin/linkedin-sync — mirror LinkedIn ad leads that Zoho's LinkedIn
 * Lead Gen Forms integration created in the CRM onto our side: a row in
 * form_submissions (form_type 'linkedin_ad') and the same team email a website
 * enquiry triggers. Idempotent: a Zoho lead id already present in Supabase is
 * skipped. Run every 15 minutes by scripts/linkedin-sync.sh (inside the
 * container; nginx blocks /api/admin/ from the internet). Token-protected.
 */
import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { zoho } from '../../../lib/zoho';
import { isLinkedInLead, leadToSubmission, recentLeadsPath, isRecent, type ZohoLeadRow } from '../../../lib/linkedin-leads';
import { notifyTeam, dubaiTime } from '../../../lib/team-notify';
import { escapeHtml as esc } from '../../../lib/escape';

export const prerender = false;

const url = import.meta.env.PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN = process.env.ZOHO_RESYNC_TOKEN;
const LOOKBACK_DAYS = 3;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function alertTeam(row: ReturnType<typeof leadToSubmission>, leadId: string) {
  const time = dubaiTime();
  const crmUrl = `https://crm.zoho.com/crm/tab/Leads/${leadId}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#111;border:1px solid rgba(255,255,255,.06);border-radius:16px">
  <tr><td style="height:3px;background:linear-gradient(90deg,#0a66c2,#24d758)"></td></tr>
  <tr><td style="padding:24px 28px">
    <span style="display:inline-block;background:#0d1b2a;border:1px solid rgba(10,102,194,.4);border-radius:16px;padding:4px 12px;color:#7cc4ff;font-size:11px;font-weight:700;letter-spacing:.05em">NEW LINKEDIN AD LEAD</span>
    <span style="float:right;color:#555;font-size:12px">${esc(time)}</span>
    <h2 style="color:#fff;font-size:20px;font-weight:700;margin:16px 0 4px">${esc(row.name)}</h2>
    <p style="color:#24d758;font-size:14px;margin:0 0 12px">${esc(row.email || 'no email on the form')}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;border-radius:10px;overflow:hidden">
      ${row.company ? `<tr><td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.04)"><span style="color:#666;font-size:12px;text-transform:uppercase">Company</span><br><span style="color:#fff;font-size:14px">${esc(row.company)}</span></td></tr>` : ''}
      ${row.job_title ? `<tr><td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.04)"><span style="color:#666;font-size:12px;text-transform:uppercase">Job title</span><br><span style="color:#fff;font-size:14px">${esc(row.job_title)}</span></td></tr>` : ''}
      ${row.phone ? `<tr><td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.04)"><span style="color:#666;font-size:12px;text-transform:uppercase">Phone</span><br><span style="color:#fff;font-size:14px">${esc(row.phone)}</span></td></tr>` : ''}
      ${row.metadata.campaign ? `<tr><td style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.04)"><span style="color:#666;font-size:12px;text-transform:uppercase">Campaign</span><br><span style="color:#fff;font-size:14px">${esc(row.metadata.campaign)}</span></td></tr>` : ''}
      ${row.message ? `<tr><td style="padding:10px 16px"><span style="color:#666;font-size:12px;text-transform:uppercase">Message</span><br><span style="color:#ccc;font-size:14px">${esc(row.message)}</span></td></tr>` : ''}
    </table>
    <p style="margin:18px 0 0"><a href="${crmUrl}" style="display:inline-block;background:#24d758;color:#051a0c!important;font-weight:700;font-size:13px;padding:10px 24px;border-radius:8px;text-decoration:none">Open in Zoho CRM</a>
    ${row.email ? `&nbsp; <a href="mailto:${esc(row.email)}" style="display:inline-block;background:#1a1a1a;border:1px solid rgba(255,255,255,.1);color:#fff!important;font-weight:600;font-size:13px;padding:10px 24px;border-radius:8px;text-decoration:none">Reply</a>` : ''}</p>
  </td></tr>
</table>
</body></html>`;
  await notifyTeam({
    subject: `New LinkedIn ad lead: ${row.name}${row.company ? ' — ' + row.company : ''}`,
    html,
    text: [`New LinkedIn ad lead — ${time}`, `Name: ${row.name}`, `Email: ${row.email || '-'}`, row.company ? `Company: ${row.company}` : null, row.job_title ? `Job title: ${row.job_title}` : null, row.phone ? `Phone: ${row.phone}` : null, row.metadata.campaign ? `Campaign: ${row.metadata.campaign}` : null, row.message ? `Message: ${row.message}` : null, '', `Zoho CRM: ${crmUrl}`].filter(Boolean).join('\n'),
    replyTo: row.email || undefined,
  });
}

export const POST: APIRoute = async ({ request }) => {
  const given = request.headers.get('x-resync-token') || '';
  if (!TOKEN || !timingSafeEqual(given, TOKEN)) return json({ error: 'Unauthorized' }, 401);
  if (!zoho.enabled) return json({ ok: false, error: 'zoho not configured' });
  if (!url || !key) return json({ ok: false, error: 'supabase not configured' });
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  const q = await zoho.get(recentLeadsPath());
  if (!q.ok) { console.error('[linkedin-sync] list failed:', q.error); return json({ ok: false, error: q.error }); }

  const recent = (q.rows as ZohoLeadRow[]).filter((l) => isRecent(l, since));
  const candidates = recent.filter(isLinkedInLead);
  const out = { ok: true, scanned: recent.length, linkedin: candidates.length, mirrored: 0, skipped: 0, failed: 0, failures: [] as { id: string; error: string }[] };
  if (!candidates.length) return json(out);

  const ids = candidates.map((c) => String(c.id));
  const { data: existing, error: exErr } = await supabase.from('form_submissions').select('zoho_lead_id').in('zoho_lead_id', ids);
  if (exErr) { out.ok = false; out.failures.push({ id: '-', error: `select failed: ${exErr.message}` }); return json(out); }
  const seen = new Set((existing || []).map((r: any) => String(r.zoho_lead_id)));

  for (const lead of candidates) {
    const id = String(lead.id);
    if (seen.has(id)) { out.skipped++; continue; }
    const row = leadToSubmission(lead);
    const { error } = await supabase.from('form_submissions').insert(row);
    if (error) { out.failed++; out.ok = false; out.failures.push({ id, error: error.message }); console.error(`[linkedin-sync] ${id} insert failed: ${error.message}`); continue; }
    out.mirrored++;
    console.log(`[linkedin-sync] mirrored Zoho lead ${id} (${row.email || 'no email'})`);
    await alertTeam(row, id);
    await zoho.addTags(id, ['linkedin']);
  }
  return json(out);
};
