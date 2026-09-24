import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { notifyTeam as sendTeamNotification, dubaiTime } from '../../lib/team-notify';
import { parseAttribution } from '../../lib/attribution';
import { buildContactLead } from '../../lib/zoho-leads';
import { syncLead } from '../../lib/lead-sync';
import { zoho } from '../../lib/zoho';

export const prerender = false;

const smtpTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'stalwart',
  port: 587,
  secure: false,
  auth: { user: process.env.SMTP_USER || 'newsletter', pass: process.env.SMTP_PASS || '' },
  tls: { rejectUnauthorized: false },
});

function buildContactReplyHTML(name: string, company?: string, service?: string, message?: string): string {
  const firstName = (name || 'there').split(' ')[0];
  const year = new Date().getFullYear();

  const serviceMap: Record<string, string> = {
    'free-assessment': 'Free Security Assessment',
    'VAPT': 'Vulnerability Assessment & Penetration Testing',
    'ISO 27001': 'ISO 27001 Implementation & Audit Support',
    'Training': 'Cybersecurity Awareness Training',
    'Consultation': 'Security Consultation & Advisory',
  };
  const serviceFull = service ? (serviceMap[service] || service) : '';

  const serviceBlock = serviceFull
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0"><tr><td style="background:#0d1f12;border-left:3px solid #24d758;border-radius:8px;padding:16px 20px">
        <p style="margin:0 0 4px;color:#24d758;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em">Service Interest</p>
        <p style="margin:0;color:#fff;font-size:15px;font-weight:600">${serviceFull}</p>
      </td></tr></table>`
    : '';

  const companyLine = company ? `<p style="color:#666;font-size:13px;margin:0 0 20px">Company: <span style="color:#999">${company}</span></p>` : '';

  const messageBlock = message
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0"><tr><td style="background:#0a0a0a;border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:16px 20px">
        <p style="margin:0 0 6px;color:#555;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em">Your Message</p>
        <p style="margin:0;color:#999;font-size:14px;line-height:1.6;font-style:italic">"${message}"</p>
      </td></tr></table>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <!-- Logo -->
  <tr><td align="center" style="padding:0 0 32px"><a href="https://underwings.org"><img src="https://underwings.org/brand/logos/underwings-lockup-dark.png?v=3" alt="Underwings" style="height:38px;width:auto;background:#fff;padding:16px 32px;border-radius:12px"></a></td></tr>

  <!-- Main Card -->
  <tr><td style="background:#111;border:1px solid rgba(255,255,255,.06);border-radius:16px;overflow:hidden">

    <!-- Green accent -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="height:2px;background:linear-gradient(90deg,transparent 5%,#24d758 35%,#27dab4 65%,transparent 95%)"></td></tr></table>

    <!-- Greeting -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <h1 style="color:#fff;font-size:24px;font-weight:700;margin:0 0 6px">Hi ${firstName},</h1>
      <p style="color:#888;font-size:14px;margin:0 0 8px">Thank you for reaching out to Underwings.</p>
      ${companyLine}
    </td></tr></table>

    <!-- Body -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:8px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#d4d4d4;font-size:15px;line-height:1.7">

      <p>We've received your inquiry and a dedicated cybersecurity specialist from our team has been assigned to review it.</p>

      ${serviceBlock}
      ${messageBlock}

      <!-- Timeline -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td style="background:rgba(36,215,88,.04);border:1px solid rgba(36,215,88,.12);border-radius:12px;padding:24px">
        <p style="margin:0 0 14px;color:#24d758;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">What happens next</p>
        <table cellpadding="0" cellspacing="0" style="width:100%">
          <tr><td style="padding:6px 0;vertical-align:top;width:28px"><span style="display:inline-block;width:20px;height:20px;background:#24d758;color:#051a0c;border-radius:50%;text-align:center;font-size:11px;font-weight:700;line-height:20px">1</span></td><td style="padding:6px 0 6px 10px;color:#ccc;font-size:14px">Your inquiry is logged and assigned to a specialist</td></tr>
          <tr><td style="padding:6px 0;vertical-align:top;width:28px"><span style="display:inline-block;width:20px;height:20px;background:#24d758;color:#051a0c;border-radius:50%;text-align:center;font-size:11px;font-weight:700;line-height:20px">2</span></td><td style="padding:6px 0 6px 10px;color:#ccc;font-size:14px">We'll respond within <strong style="color:#fff">4&#8211;6 business hours</strong></td></tr>
          <tr><td style="padding:6px 0;vertical-align:top;width:28px"><span style="display:inline-block;width:20px;height:20px;background:#24d758;color:#051a0c;border-radius:50%;text-align:center;font-size:11px;font-weight:700;line-height:20px">3</span></td><td style="padding:6px 0 6px 10px;color:#ccc;font-size:14px">If needed, we'll schedule a call to discuss your requirements</td></tr>
        </table>
      </td></tr></table>

      <!-- Urgent -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px"><tr><td style="background:#1a1a1a;border-radius:10px;padding:16px 20px;text-align:center">
        <p style="margin:0 0 4px;color:#666;font-size:12px">Need immediate assistance?</p>
        <p style="margin:0;color:#fff;font-size:16px;font-weight:600">+971 54 707 8203</p>
      </td></tr></table>

      <!-- CTA -->
      <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:0 0 8px">
        <a href="https://underwings.org/services" style="display:inline-block;background:#24d758;color:#051a0c!important;font-weight:700;font-size:14px;padding:14px 32px;border-radius:10px;text-decoration:none">Explore Our Services</a>
      </td></tr></table>

      <p style="color:#555;font-size:13px;text-align:center;margin:16px 0 0">You can reply directly to this email — it reaches our team instantly.</p>

    </td></tr></table>

  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:28px 32px;text-align:center;font-family:-apple-system,sans-serif">
    <p style="margin:0 0 8px;color:#444;font-size:12px">&copy; ${year} Underwings Cybersecurity Solutions</p>
    <p style="margin:0 0 8px;color:#333;font-size:11px">Abu Dhabi, UAE</p>
    <p style="margin:0"><a href="https://underwings.org" style="color:#24d758;font-size:12px;text-decoration:none">underwings.org</a> &nbsp;&middot;&nbsp; <a href="https://www.linkedin.com/company/underwings-cybersecurity" style="color:#555;font-size:12px;text-decoration:none">LinkedIn</a></p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

async function sendAutoReply(email: string, name: string, company?: string, service?: string, message?: string): Promise<void> {
  try {
    const firstName = (name || '').split(' ')[0] || 'there';
    await smtpTransport.sendMail({
      from: 'Underwings <newsletter@underwings.org>',
      replyTo: 'contact@underwings.org',
      to: email,
      subject: `${firstName}, we've received your inquiry — Underwings`,
      html: buildContactReplyHTML(name, company, service, message),
    });
  } catch (e) {
    console.error('Auto-reply email error:', e);
  }
}

async function notifyTeam(name: string, email: string, phone?: string, company?: string, service?: string, message?: string): Promise<void> {
  try {
    const time = dubaiTime();

    const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:32px 0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <tr><td style="background:#111;border:1px solid rgba(255,255,255,.06);border-radius:16px;overflow:hidden">

    <!-- Red/orange accent for urgency -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="height:3px;background:linear-gradient(90deg,#24d758,#27dab4)"></td></tr></table>

    <!-- Header -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 28px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td><span style="display:inline-block;background:#0d1f12;border:1px solid rgba(36,215,88,.2);border-radius:16px;padding:4px 12px;color:#24d758;font-size:11px;font-weight:700;letter-spacing:.05em">NEW LEAD</span></td>
        <td align="right"><span style="color:#555;font-size:12px">${time}</span></td>
      </tr></table>
      <h2 style="color:#fff;font-size:20px;font-weight:700;margin:16px 0 4px">${name || 'Unknown'}</h2>
      <p style="color:#24d758;font-size:14px;margin:0">${email}</p>
    </td></tr></table>

    <!-- Details -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 28px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">

      <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;background:#0a0a0a;border-radius:10px;overflow:hidden">
        ${company ? `<tr><td style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.04)"><span style="color:#666;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Company</span><br><span style="color:#fff;font-size:14px">${company}</span></td></tr>` : ''}
        ${phone ? `<tr><td style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.04)"><span style="color:#666;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Phone</span><br><span style="color:#fff;font-size:14px">${phone}</span></td></tr>` : ''}
        ${service ? `<tr><td style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.04)"><span style="color:#666;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Service Interest</span><br><span style="color:#24d758;font-size:14px;font-weight:600">${service}</span></td></tr>` : ''}
        ${message ? `<tr><td style="padding:12px 16px"><span style="color:#666;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Message</span><br><span style="color:#ccc;font-size:14px;line-height:1.6">${message}</span></td></tr>` : ''}
      </table>

      <!-- CTA -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 0"><tr>
        <td><a href="https://underwings.org/admin/" style="display:inline-block;background:#24d758;color:#051a0c!important;font-weight:700;font-size:13px;padding:10px 24px;border-radius:8px;text-decoration:none">Open admin console</a></td>
        <td align="right"><a href="mailto:${email}" style="display:inline-block;background:#1a1a1a;border:1px solid rgba(255,255,255,.1);color:#fff!important;font-weight:600;font-size:13px;padding:10px 24px;border-radius:8px;text-decoration:none">Reply to Lead</a></td>
      </tr></table>

    </td></tr></table>
  </td></tr>

  <tr><td style="padding:16px 28px;text-align:center;font-family:-apple-system,sans-serif">
    <p style="margin:0;color:#333;font-size:11px">Underwings admin &middot; <a href="https://underwings.org/admin/" style="color:#555;text-decoration:none">underwings.org/admin</a></p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

    // Recipients + transport live in lib/team-notify (FORM_NOTIFY_TO, NOTIFY_SMTP_*).
    await sendTeamNotification({
      subject: `New Lead: ${name || 'Unknown'}${service ? ' — ' + service : ''}`,
      html,
      text: [
        `New website lead — ${time}`,
        `Name: ${name || 'Unknown'}`,
        `Email: ${email}`,
        phone ? `Phone: ${phone}` : null,
        company ? `Company: ${company}` : null,
        service ? `Service interest: ${service}` : null,
        message ? `Message:\n${message}` : null,
        '',
        'Admin console: https://underwings.org/admin/',
      ].filter(Boolean).join('\n'),
      replyTo: email,
    });
  } catch (e) {
    console.error('Team notification error:', e);
  }
}

const TURNSTILE_SECRET = import.meta.env.TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET_KEY;

// Supabase for saving form submissions locally
const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && (supabaseServiceKey || supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey)
  : null;

async function verifyTurnstile(token: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token }),
  });
  const data = await res.json();
  return data.success === true;
}


export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();

    // Verify Turnstile CAPTCHA if configured and token present
    if (TURNSTILE_SECRET) {
      const turnstileToken = body['cf-turnstile-response'];
      if (turnstileToken && !await verifyTurnstile(turnstileToken)) {
        return new Response(JSON.stringify({ error: 'CAPTCHA verification failed' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      delete body['cf-turnstile-response'];
    }

    // Extract fields from form payload
    const fields: Record<string, string> = {};
    if (body.fields && Array.isArray(body.fields)) {
      for (const f of body.fields) {
        fields[f.name] = f.value;
      }
    }

    const email = typeof fields.email === 'string' ? fields.email.trim() : '';
    const name = fields.fullname || fields['0-2/name'] || [fields.firstname, fields.lastname].filter(Boolean).join(' ') || null;
    const phone = fields.phone || null;
    const company = fields.company || null;
    // The form sends the service select as `what_can_we_help_with_` and the free
    // text as `message`. (Before 2026-09-24 these were swapped on the server and
    // the visitor's message was lost whenever a service was chosen.)
    const service = fields.what_can_we_help_with_ || fields.service_interest || fields.service || null;
    const message = fields.message || null;
    const attribution = parseAttribution(body.attribution);

    // Save to Supabase, auto-reply and team notification in parallel
    if (supabase && email) {
      const [supabaseResult] = await Promise.all([
        supabase.from('form_submissions').insert({
          form_type: 'contact',
          name,
          email,
          phone,
          company,
          message,
          service_interest: service,
          status: 'new',
          metadata: Object.keys(attribution).length ? { attribution } : null,
        }).select('id').single(),
        sendAutoReply(email, name || 'there', company || undefined, service || undefined, message || undefined),
        notifyTeam(name || 'Unknown', email, phone || undefined, company || undefined, service || undefined, message || undefined),
      ]);

      if (supabaseResult.error) {
        console.error('Supabase form save error:', supabaseResult.error.message);
        return new Response(JSON.stringify({ error: 'Submission failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Zoho CRM: best-effort and NOT awaited — the visitor's response never waits on Zoho
      // (review finding #3: three 8 s calls could push past nginx's 30 s proxy timeout).
      const recordId = String(supabaseResult.data?.id ?? '');
      if (recordId) {
        void syncLead({
          supabase, table: 'form_submissions', recordId, form: 'Contact',
          payload: buildContactLead({ name, email, phone, company, service, message, recordId, attribution }, zoho.ownerId),
          repeatDetails: [service ? `Service: ${service}` : null, company ? `Company: ${company}` : null, phone ? `Phone: ${phone}` : null, message ? `Message:\n${message}` : null].filter(Boolean).join('\n'),
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Submission failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Contact API error:', err);
    return new Response(JSON.stringify({ error: 'Submission failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
