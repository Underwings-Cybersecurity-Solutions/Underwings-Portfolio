/**
 * Team notifications for website form submissions (contact, newsletter, waitlist).
 *
 * Recipients: FORM_NOTIFY_TO (comma-separated), default admin@ + manoj@.
 *
 * Transport: NOTIFY_SMTP_* when set — in production that is the Brevo relay
 * (the same account Stalwart itself relays through). It is deliberately NOT
 * the `stalwart` container: Stalwart still lists underwings.org as a LOCAL
 * domain, so anything it accepts for an @underwings.org address is filed into
 * its own mailboxes — abandoned since the 2026-08-27 Zoho cutover — instead of
 * being sent to the domain's MX. Falls back to SMTP_* (Stalwart) when
 * NOTIFY_SMTP_HOST is absent, e.g. in CI, so nothing breaks there.
 *
 * Never throws: a notification failure must not fail the visitor's submission.
 * It does log loudly, so a broken relay is visible in `docker logs`.
 */
import nodemailer from 'nodemailer';

const DEFAULT_RECIPIENTS = 'admin@underwings.org, manoj@underwings.org';

export function teamRecipients(): string[] {
  const raw = process.env.FORM_NOTIFY_TO || DEFAULT_RECIPIENTS;
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
}

const dedicated = !!process.env.NOTIFY_SMTP_HOST;
const host = process.env.NOTIFY_SMTP_HOST || process.env.SMTP_HOST || 'stalwart';
const port = Number(process.env.NOTIFY_SMTP_PORT || process.env.SMTP_PORT || 587);
const user = process.env.NOTIFY_SMTP_USER || process.env.SMTP_USER || 'newsletter@underwings.org';
const pass = process.env.NOTIFY_SMTP_PASS || process.env.SMTP_PASS || '';

const transport = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  // Brevo: real certificate, never send credentials before STARTTLS.
  // Stalwart fallback: self-signed cert on the container network.
  requireTLS: dedicated,
  auth: { user, pass },
  tls: { rejectUnauthorized: dedicated },
});

export const NOTIFY_FROM = process.env.NOTIFY_FROM || 'Underwings Website <newsletter@underwings.org>';

export function dubaiTime(): string {
  return new Date().toLocaleString('en-AE', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' });
}

export interface TeamNotification {
  subject: string;
  html: string;
  /** Plain-text alternative (mail previews, screen readers). */
  text?: string;
  /** Visitor's address so "Reply" in the inbox goes to the lead. */
  replyTo?: string;
}

export async function notifyTeam(n: TeamNotification): Promise<boolean> {
  const to = teamRecipients();
  if (to.length === 0) {
    console.warn('[team-notify] FORM_NOTIFY_TO is empty — no notification sent for:', n.subject);
    return false;
  }
  try {
    const info = await transport.sendMail({
      from: NOTIFY_FROM,
      to,
      replyTo: n.replyTo,
      subject: n.subject,
      html: n.html,
      text: n.text,
    });
    console.log(`[team-notify] sent "${n.subject}" to ${to.join(', ')} via ${host}:${port} — ${info.response}`);
    return true;
  } catch (e) {
    console.error(`[team-notify] FAILED "${n.subject}" to ${to.join(', ')} via ${host}:${port}:`, e);
    return false;
  }
}
