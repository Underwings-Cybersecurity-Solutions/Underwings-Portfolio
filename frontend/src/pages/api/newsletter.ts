import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';
import { notifyTeam, dubaiTime } from '../../lib/team-notify';
import { parseAttribution } from '../../lib/attribution';
import { buildNewsletterLead } from '../../lib/zoho-leads';
import { syncLead } from '../../lib/lead-sync';
import { zoho } from '../../lib/zoho';

export const prerender = false;

const TURNSTILE_SECRET = import.meta.env.TURNSTILE_SECRET_KEY || process.env.TURNSTILE_SECRET_KEY;

// Supabase client for saving subscribers locally
const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const supabaseServiceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || process.env.PUBLIC_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && (supabaseServiceKey || supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseServiceKey || supabaseAnonKey)
  : null;

// SMTP transport for welcome email
const smtpTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'stalwart',
  port: 587,
  secure: false,
  auth: { user: process.env.SMTP_USER || 'admin', pass: process.env.SMTP_PASS || '' },
  tls: { rejectUnauthorized: false },
});

function buildWelcomeHTML(email: string): string {
  const name = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const year = new Date().getFullYear();

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

  <!-- Logo -->
  <tr><td align="center" style="padding:0 0 32px"><a href="https://underwings.org"><img src="https://underwings.org/brand/logos/underwings-lockup-dark.png?v=3" alt="Underwings" style="height:38px;width:auto;background:#fff;padding:16px 32px;border-radius:12px"></a></td></tr>

  <!-- Main Card -->
  <tr><td style="background:#111;border:1px solid rgba(255,255,255,.06);border-radius:16px;overflow:hidden">

    <!-- Gradient accent -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="height:3px;background:linear-gradient(90deg,#24d758,#27dab4,#24d758)"></td></tr></table>

    <!-- Welcome badge -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 32px 0">
      <table cellpadding="0" cellspacing="0"><tr><td style="background:#0d1f12;border:1px solid rgba(36,215,88,.2);border-radius:20px;padding:6px 16px">
        <span style="color:#24d758;font-size:12px;font-weight:700;font-family:-apple-system,sans-serif;letter-spacing:.05em">YOU'RE IN</span>
      </td></tr></table>
    </td></tr></table>

    <!-- Greeting -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:20px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center">
      <h1 style="color:#fff;font-size:26px;font-weight:700;margin:0 0 8px">Welcome, ${name}!</h1>
      <p style="color:#888;font-size:14px;margin:0 0 24px">You've joined the Underwings cybersecurity mailing list.</p>
    </td></tr></table>

    <!-- Body -->
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#d4d4d4;font-size:15px;line-height:1.7">

      <p>You'll now receive curated security intelligence, practical guidance, and insider knowledge from our OSCP+ & CPTS certified team — no spam, no fluff, just what matters.</p>

      <!-- What you'll get - cards grid -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0">
        <tr>
          <td style="width:50%;padding:6px 6px 6px 0;vertical-align:top">
            <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#1a1a1a;border-radius:10px;padding:16px">
              <p style="margin:0 0 4px;font-size:18px">&#128274;</p>
              <p style="margin:0 0 4px;color:#fff;font-size:13px;font-weight:700">Threat Alerts</p>
              <p style="margin:0;color:#888;font-size:12px;line-height:1.5">Emerging vulnerabilities and attack trends</p>
            </td></tr></table>
          </td>
          <td style="width:50%;padding:6px 0 6px 6px;vertical-align:top">
            <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#1a1a1a;border-radius:10px;padding:16px">
              <p style="margin:0 0 4px;font-size:18px">&#128736;</p>
              <p style="margin:0 0 4px;color:#fff;font-size:13px;font-weight:700">Practical Tips</p>
              <p style="margin:0;color:#888;font-size:12px;line-height:1.5">Actionable security advice for your org</p>
            </td></tr></table>
          </td>
        </tr>
        <tr>
          <td style="width:50%;padding:6px 6px 6px 0;vertical-align:top">
            <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#1a1a1a;border-radius:10px;padding:16px">
              <p style="margin:0 0 4px;font-size:18px">&#128220;</p>
              <p style="margin:0 0 4px;color:#fff;font-size:13px;font-weight:700">Compliance Updates</p>
              <p style="margin:0;color:#888;font-size:12px;line-height:1.5">ISO 27001, NIST, NESA & more</p>
            </td></tr></table>
          </td>
          <td style="width:50%;padding:6px 0 6px 6px;vertical-align:top">
            <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#1a1a1a;border-radius:10px;padding:16px">
              <p style="margin:0 0 4px;font-size:18px">&#127891;</p>
              <p style="margin:0 0 4px;color:#fff;font-size:13px;font-weight:700">Expert Insights</p>
              <p style="margin:0;color:#888;font-size:12px;line-height:1.5">From our certified pen-testing team</p>
            </td></tr></table>
          </td>
        </tr>
      </table>

      <!-- CTA -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 8px"><tr><td align="center">
        <p style="color:#999;font-size:14px;margin:0 0 16px">In the meantime, see what we can do for your security posture:</p>
        <a href="https://underwings.org/services" style="display:inline-block;background:#24d758;color:#051a0c!important;font-weight:700;font-size:14px;padding:14px 32px;border-radius:10px;text-decoration:none">Explore Our Services</a>
      </td></tr></table>

      <p style="color:#555;font-size:13px;text-align:center;margin:20px 0 0">Have a question? Just reply to this email — we read every one.</p>

    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="height:24px"></td></tr></table>
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

async function sendWelcomeEmail(email: string): Promise<void> {
  try {
    await smtpTransport.sendMail({
      from: 'Underwings <newsletter@underwings.org>',
      replyTo: 'contact@underwings.org',
      to: email,
      subject: 'Welcome to Underwings — You\'re In!',
      html: buildWelcomeHTML(email),
    });
  } catch (e) {
    console.error('Welcome email error:', e);
  }
}

/** Tell the team about the signup — same recipients as the contact form. */
async function notifyTeamOfSignup(email: string, source: string): Promise<void> {
  const time = dubaiTime();
  const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#111;border:1px solid rgba(255,255,255,.06);border-radius:16px">
  <tr><td style="height:3px;background:linear-gradient(90deg,#24d758,#27dab4)"></td></tr>
  <tr><td style="padding:24px 28px">
    <span style="display:inline-block;background:#0d1f12;border:1px solid rgba(36,215,88,.2);border-radius:16px;padding:4px 12px;color:#24d758;font-size:11px;font-weight:700;letter-spacing:.05em">NEW NEWSLETTER SIGNUP</span>
    <span style="float:right;color:#555;font-size:12px">${time}</span>
    <h2 style="color:#fff;font-size:20px;font-weight:700;margin:16px 0 4px">${email}</h2>
    <p style="color:#888;font-size:13px;margin:0 0 16px">Source: <span style="color:#ccc">${source}</span></p>
    <a href="https://underwings.org/admin/" style="display:inline-block;background:#24d758;color:#051a0c!important;font-weight:700;font-size:13px;padding:10px 24px;border-radius:8px;text-decoration:none">Open admin console</a>
  </td></tr>
</table>
</body></html>`;
  await notifyTeam({
    subject: `New newsletter signup: ${email}`,
    html,
    text: `New newsletter signup — ${time}\nEmail: ${email}\nSource: ${source}\n\nAdmin console: https://underwings.org/admin/`,
    replyTo: email,
  });
}

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
    const { email, lead_magnet } = body;

    // Validate email
    if (!email || typeof email !== 'string' || !email.includes('@') || email.length < 5) {
      return new Response(JSON.stringify({ error: 'Valid email required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify Turnstile CAPTCHA only if a token was submitted
    if (TURNSTILE_SECRET) {
      const turnstileToken = body['cf-turnstile-response'];
      if (turnstileToken && !await verifyTurnstile(turnstileToken)) {
        return new Response(JSON.stringify({ error: 'CAPTCHA verification failed' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const cleanEmail = email.toLowerCase().trim();
    const source = lead_magnet ? `lead_magnet:${lead_magnet}` : 'newsletter';
    const attribution = parseAttribution(body.attribution);

    // Friendly name derived from the local-part of the email
    const friendlyName = cleanEmail.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Save to Supabase + send welcome email + notify the team
    const [supabaseResult] = await Promise.all([
      supabase
        ? supabase.from('subscribers').upsert(
            { email: cleanEmail, subscription_source: source, subscribed: true, ...(Object.keys(attribution).length ? { attribution } : {}) },
            { onConflict: 'email' }
          ).select('id').single()
        : Promise.resolve({ data: null, error: { message: 'No Supabase client' } }),
      sendWelcomeEmail(cleanEmail),
      notifyTeamOfSignup(cleanEmail, source),
    ]);

    if (supabase && supabaseResult.error) {
      console.error('Supabase subscriber save error:', supabaseResult.error?.message || JSON.stringify(supabaseResult.error));
      return new Response(JSON.stringify({ error: 'Subscription failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Zoho CRM: best-effort, after the row is safe in Supabase. Never affects the response.
    const recordId = String((supabaseResult as any)?.data?.id ?? '');
    if (recordId) {
      await syncLead({
        supabase, table: 'subscribers', recordId, form: source.startsWith('lead_magnet:') ? 'Resource Download' : 'Newsletter',
        lead: buildNewsletterLead({ email: cleanEmail, source, recordId, attribution }, zoho.ownerId),
        repeatDetails: `Source: ${source}`,
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Newsletter API error:', err);
    return new Response(JSON.stringify({ error: 'Subscription failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
