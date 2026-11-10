// ============================================================
// POST /api/careers
// Careers application form (multipart/form-data).
//
// Flow:
//   1. Validate fields + CV (PDF/DOC/DOCX, max 5 MB, magic-byte checked)
//   2. Save the application to Supabase `form_submissions`
//      (form_type = 'career'; role/links/CV metadata in `metadata`)
//   3. Email careers@underwings.org with the CV attached
//   4. Send the candidate a confirmation email
//
// The CV itself is NOT stored in the database — it only travels as an email
// attachment, which keeps PDPL retention scope to the mailbox.
// Candidates are deliberately NOT pushed to n8n/Krayin: that CRM is the
// sales pipeline, and applicants are not leads.
//
// The submission succeeds if either the DB save or the team email succeeds,
// so a missing migration or an SMTP blip never silently loses an application.
// ============================================================

import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { escapeHtml as esc } from '../../lib/escape';

export const prerender = false;

const CAREERS_INBOX = process.env.CAREERS_INBOX || 'careers@underwings.org';

const smtpTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'stalwart',
  port: 587,
  secure: false,
  auth: { user: process.env.SMTP_USER || 'newsletter', pass: process.env.SMTP_PASS || '' },
  tls: { rejectUnauthorized: false },
});

const supabaseUrl        = import.meta.env.PUBLIC_SUPABASE_URL       || process.env.PUBLIC_SUPABASE_URL;
const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey    = import.meta.env.PUBLIC_SUPABASE_ANON_KEY  || process.env.PUBLIC_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && (supabaseServiceKey || supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey)
  : null;

// ---------- validation ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CV_BYTES = 5 * 1024 * 1024;
const LIMITS = { name: 120, email: 254, phone: 40, role: 120, link: 300, note: 3000 };

const CV_TYPES: Record<string, { mime: string; magic: number[] }> = {
  pdf:  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },                                  // %PDF
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [0x50, 0x4b, 0x03, 0x04] }, // PK..
  doc:  { mime: 'application/msword', magic: [0xd0, 0xcf, 0x11, 0xe0] },                               // OLE2
};

// ---------- rate limit (in-memory, single instance — same as /api/waitlist) ----------
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap.entries()) {
    if (now - v.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(k);
  }
}, 10 * 60 * 1000).unref?.();

function clientIp(request: Request, fallback?: string): string {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    fallback ||
    'unknown'
  );
}

function str(form: FormData, key: string, max: number): string {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function safeUrl(v: string): string {
  if (!v) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ---------- emails ----------
function teamEmailHtml(a: { name: string; email: string; phone: string; role: string; link: string; note: string; cvName: string }): string {
  const time = new Date().toLocaleString('en-AE', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' });
  const row = (label: string, value: string) =>
    value ? `<tr><td style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.04)"><span style="color:#666;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">${label}</span><br><span style="color:#fff;font-size:14px;line-height:1.6;white-space:pre-wrap">${value}</span></td></tr>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:32px 0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <tr><td style="background:#111;border:1px solid rgba(255,255,255,.06);border-radius:16px;overflow:hidden">
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="height:3px;background:linear-gradient(90deg,#24d758,#27dab4)"></td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 28px 16px">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td><span style="display:inline-block;background:#0d1f12;border:1px solid rgba(36,215,88,.2);border-radius:16px;padding:4px 12px;color:#24d758;font-size:11px;font-weight:700;letter-spacing:.05em">NEW APPLICATION</span></td>
        <td align="right"><span style="color:#555;font-size:12px">${esc(time)}</span></td>
      </tr></table>
      <h2 style="color:#fff;font-size:20px;font-weight:700;margin:16px 0 4px">${esc(a.name)}</h2>
      <p style="color:#24d758;font-size:14px;margin:0">${esc(a.role)}</p>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 28px 24px">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;border-radius:10px;overflow:hidden">
        ${row('Email', esc(a.email))}
        ${row('Phone', esc(a.phone))}
        ${row('LinkedIn / portfolio', a.link ? `<a href="${esc(a.link)}" style="color:#24d758">${esc(a.link)}</a>` : '')}
        ${row('CV', a.cvName ? `${esc(a.cvName)} (attached)` : 'Not attached')}
        ${row('Note', esc(a.note))}
      </table>
      <p style="margin:16px 0 0"><a href="mailto:${esc(a.email)}" style="display:inline-block;background:#24d758;color:#051a0c;font-weight:700;font-size:13px;padding:10px 24px;border-radius:8px;text-decoration:none">Reply to candidate</a></p>
    </td></tr></table>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function candidateEmailHtml(firstName: string, role: string): string {
  const year = new Date().getFullYear();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <tr><td align="center" style="padding:0 0 32px"><img src="https://underwings.org/brand/logos/underwings-lockup-dark.png" alt="Underwings" style="height:38px;width:auto;background:#fff;padding:16px 32px;border-radius:12px"></td></tr>
  <tr><td style="background:#111;border:1px solid rgba(255,255,255,.06);border-radius:16px;padding:32px;color:#d4d4d4;font-size:15px;line-height:1.7">
    <h1 style="color:#fff;font-size:24px;font-weight:700;margin:0 0 12px">Hi ${esc(firstName)},</h1>
    <p style="margin:0 0 16px">Thanks for applying to Underwings. We've received your application for <strong style="color:#24d758">${esc(role)}</strong>.</p>
    <p style="margin:0 0 8px;color:#24d758;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">What happens next</p>
    <ol style="margin:0 0 16px;padding-left:20px;color:#ccc;font-size:14px">
      <li>A founder reads every application. We reply within one working day, even if it's a no.</li>
      <li>If there's a fit: a 30-minute intro call with a founder and one practitioner.</li>
      <li>A craft check: a relevant exercise or technical conversation. Never unpaid client work.</li>
    </ol>
    <p style="margin:0;color:#888;font-size:13px">You can reply to this email to add anything to your application.</p>
  </td></tr>
  <tr><td style="padding:28px 32px;text-align:center">
    <p style="margin:0 0 8px;color:#444;font-size:12px">&copy; ${year} Underwings Cybersecurity Solutions · Abu Dhabi, UAE</p>
    <p style="margin:0"><a href="https://underwings.org/careers" style="color:#24d758;font-size:12px;text-decoration:none">underwings.org/careers</a></p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ---------- handler ----------
export const POST: APIRoute = async ({ request, clientAddress }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Invalid form submission' }, 400);
  }

  // Honeypot: bots fill hidden fields. Pretend success, do nothing.
  if (str(form, 'website', 200)) return json({ success: true }, 200);

  const ip = clientIp(request, clientAddress);
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
  if (!checkRateLimit(ipHash)) {
    return json({ error: 'Too many applications from this connection. Please email careers@underwings.org.' }, 429);
  }

  const name  = str(form, 'name', LIMITS.name);
  const email = str(form, 'email', LIMITS.email).toLowerCase();
  const phone = str(form, 'phone', LIMITS.phone);
  const role  = str(form, 'role', LIMITS.role) || 'Open application';
  const link  = safeUrl(str(form, 'link', LIMITS.link));
  const note  = str(form, 'note', LIMITS.note);
  const consent = form.get('consent') === 'on' || form.get('consent') === 'true';

  const errors: Record<string, string> = {};
  if (name.length < 2) errors.name = 'Please enter your full name.';
  if (!EMAIL_RE.test(email)) errors.email = 'Please enter a valid email address.';
  if (!consent) errors.consent = 'Please confirm we may process your application.';

  // CV
  let cv: { filename: string; content: Buffer; contentType: string } | null = null;
  const file = form.get('cv');
  if (file && typeof file !== 'string' && file.size > 0) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const type = CV_TYPES[ext];
    if (!type) {
      errors.cv = 'CV must be a PDF, DOC or DOCX file.';
    } else if (file.size > MAX_CV_BYTES) {
      errors.cv = 'CV must be 5 MB or smaller.';
    } else {
      const buf = Buffer.from(await file.arrayBuffer());
      if (!type.magic.every((b, i) => buf[i] === b)) {
        errors.cv = 'That file does not look like a valid PDF or Word document.';
      } else {
        const safeName = name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'candidate';
        cv = { filename: `CV-${safeName}.${ext}`, content: buf, contentType: type.mime };
      }
    }
  } else if (!link) {
    errors.cv = 'Please attach your CV or add a LinkedIn / portfolio link.';
  }

  if (Object.keys(errors).length > 0) return json({ error: 'Please fix the highlighted fields.', fields: errors }, 400);

  const userAgent = (request.headers.get('user-agent') || '').slice(0, 500);

  const [dbResult, teamResult] = await Promise.allSettled([
    supabase
      ? supabase.from('form_submissions').insert({
          form_type: 'career',
          name,
          email,
          phone: phone || null,
          message: note || null,
          service_interest: role,
          metadata: {
            role,
            link: link || null,
            cv_filename: cv?.filename || null,
            cv_bytes: cv?.content.length || null,
            ip_hash: ipHash,
          },
          user_agent: userAgent || null,
          status: 'new',
        }).then((r) => { if (r.error) throw new Error(r.error.message); })
      : Promise.reject(new Error('Supabase not configured')),
    smtpTransport.sendMail({
      from: 'Underwings Careers <newsletter@underwings.org>',
      to: CAREERS_INBOX,
      replyTo: `${name.replace(/[<>"\r\n]/g, '')} <${email}>`,
      subject: `Application: ${role} — ${name}`,
      html: teamEmailHtml({ name, email, phone, role, link, note, cvName: cv?.filename || '' }),
      attachments: cv ? [cv] : [],
    }),
  ]);

  if (dbResult.status === 'rejected') console.error('[careers] DB save failed:', dbResult.reason);
  if (teamResult.status === 'rejected') console.error('[careers] team email failed:', teamResult.reason);

  if (dbResult.status === 'rejected' && teamResult.status === 'rejected') {
    return json({ error: 'We could not submit your application. Please email careers@underwings.org.' }, 500);
  }

  // Candidate confirmation — best effort, never fails the request.
  smtpTransport.sendMail({
    from: 'Underwings Careers <newsletter@underwings.org>',
    replyTo: CAREERS_INBOX,
    to: email,
    subject: `We've received your application — Underwings`,
    html: candidateEmailHtml(name.split(' ')[0] || 'there', role),
  }).catch((e) => console.error('[careers] candidate confirmation failed:', e));

  return json({ success: true }, 200);
};
