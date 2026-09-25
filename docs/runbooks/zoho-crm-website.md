# Zoho CRM ← underwings.org website leads

Spec: `docs/superpowers/specs/2026-09-24-zoho-crm-website-leads-design.md`.
Plan: `docs/superpowers/plans/2026-09-24-zoho-crm-website-leads.md`.

## Zoho org (created 2026-09-24, US data centre `.com`)

| Item | Value |
|---|---|
| Org id | `7626271000000020005` |
| Owner user (Manoj Prabhakaran) | `7626271000000625001` |
| Accounts / API hosts | `https://accounts.zoho.com` / `https://www.zohoapis.com` |
| Plan | Professional **trial until 2026-10-08** (API keeps working on any paid plan; on lapse, leads queue in Supabase and the nightly resync catches up) |

## Custom fields on Leads (created 2026-09-24 through the MCP)

`Website_Form` (picklist: Contact, Waitlist, Newsletter, Resource Download), `Service_Interest`,
`Resource_Downloaded`, `Waitlist_Year` (2027, 2028), `UTM_Source`, `UTM_Medium`, `UTM_Campaign`,
`UTM_Term`, `UTM_Content`, `Landing_Page`, `Conversion_Page`, `Referrer_URL` (Zoho rejects the
label "Referrer" as a system keyword), `GA_Client_ID`, `Website_Record_ID`.
Standard fields used: `Lead_Source` = `Website` (value added by the owner), `Lead_Status`
(`Not Contacted` for contact-form leads, `Contact in Future` for newsletter / downloads),
`Description`, `Owner`, `Tag` (`website`, `contact-form`, `waitlist`, `newsletter`, `resource-download`).

Assignment rules cannot be created through the MCP; the website sets `Owner` explicitly. When a
second sales user joins, create a Leads assignment rule in Setup → Automation → Assignment and
route by `Website_Form`.

## How it works

```
browser ──POST /api/contact|waitlist|newsletter──▶ Astro route (frontend container)
   │ (sends `attribution` from the first-party uw_attr cookie)   ├─ Supabase insert      (unchanged)
   │                                                            ├─ team mail via Brevo  (unchanged; now also contact@)
   │                                                            ├─ visitor auto-reply   (unchanged; carries the PDF for downloads)
   │                                                            └─ lib/lead-sync.ts → lib/zoho.ts → POST /crm/v7/Leads/upsert (key: Email)
   └─ nightly cron 03:15 Dubai: scripts/zoho-resync.sh → POST /api/admin/zoho-resync (rows with zoho_lead_id NULL)
```

Mapping lives in `frontend/src/lib/zoho-leads.ts` (pure, unit-tested). Each mapper returns an
`insert` record (new Lead) and an `update` subset (existing Lead). The website looks the email up
with COQL first; a known email gets ONLY the update subset (fields the visitor typed on this form,
the latest `Website_Form`/`Conversion_Page`/`Website_Record_ID`), the form's tags appended, and a
dated Note. `Lead_Status`, `Owner`, `Lead_Source`, `Email_Opt_Out`, `Description`, first-touch
UTM fields, placeholder company and email-derived names are never written onto an existing Lead,
so sales-entered data survives repeat visits (review finding, 2026-09-24).
Newsletter and resource-download leads get `Lead_Status = Contact in Future`; contact-form leads
`Not Contacted`. The visitor's response never depends on Zoho: failures are logged and retried nightly.

## Environment variables (gitignored `.env`, passed to `frontend` by compose)

`ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` (Self Client created 2026-09-24, scope
`ZohoCRM.modules.ALL,ZohoCRM.settings.READ,ZohoCRM.coql.READ`), `ZOHO_ACCOUNTS_URL`, `ZOHO_API_URL`,
`ZOHO_OWNER_ID`, `ZOHO_RESYNC_TOKEN` (shared secret for the resync route),
`FORM_NOTIFY_TO=admin@,manoj@,contact@underwings.org`.
Without the first three the routes work as before and log one warning at boot.

## Rotate the refresh token

1. `https://api-console.zoho.com` → the Self Client → Generate Code → same scope, 10 minutes.
2. `curl -s -X POST https://accounts.zoho.com/oauth/v2/token -d grant_type=authorization_code -d client_id=… -d client_secret=… -d code=…`
3. Replace `ZOHO_REFRESH_TOKEN` in `.env`, then `docker compose up -d frontend` (env only, no rebuild).
   Rollback of the whole integration: remove the `ZOHO_*` lines from `.env`, `docker compose up -d
   frontend`, and delete the `zoho-resync.sh` line from `crontab -e` (otherwise it alerts after 3 nights).
4. Check `docker logs underwings-frontend | grep '\[zoho\]'` after the next submission, or run
   `scripts/zoho-resync.sh` and expect `"failed":0`.

## Reading failures

- Per submission: `docker logs underwings-frontend | grep '\[zoho\]'` → `→ <id> (insert|update)` or `FAILED: <zoho error>`.
- Per row: `zoho_error` / `zoho_lead_id` / `zoho_synced_at` on `form_submissions`, `waitlist_signups`, `subscribers`.
- Nightly: `backups/zoho-resync.log` — one JSON line per run (`"ok":true` = nothing failed); an
  alert mail goes to ALERT_EMAIL only after 3 consecutive failing nights. A row is retried at most
  5 nights (`zoho_attempts`); an invalid email is marked permanent (99) on first sight. To retry a
  given-up row after fixing the cause: `update <table> set zoho_attempts = 0 where id = …`.
- Zoho returns HTTP 200 with a per-record error for bad data (e.g. a removed picklist value); the
  client treats that as a failure and logs Zoho's `details` verbatim.

## Testing

Unit: `docker run --rm -v "$PWD/frontend:/app" -w /app node:24-alpine node --test 'src/lib/*.test.mjs'`.
Live: post to `/api/contact` with a `smoke+<n>@underwings.org` marker, confirm the Lead via the Zoho
MCP (`searchRecords` by email), then delete the Lead and the Supabase row. `tests/smoke.sh` covers
the resync auth gate, attribution hardening and the checklist PDF.

## Free resources

`frontend/src/lib/resources.ts` lists every promised download. The Security Assessment Checklist
source is `frontend/public/resources/underwings-security-assessment-checklist.html`; re-render after
edits with headless Chrome (`--print-to-pdf`, see the plan, Task 14). The exit-popup passes
`lead_magnet: 'Security Assessment Checklist'`, which selects the resource by title.

## Owner follow-ons (not automatable through the MCP)

1. **Time zone and company name** — Setup → General → Company Settings: `Asia/Dubai`; fix "Cybersecuirty".
2. **Zoho-side lead-update emails to contact@** — Setup → Automation → Workflow Rules → Leads → on
   Create or Edit → Email Notification → contact@underwings.org. (Website submissions already mail contact@.)
3. **Meeting scheduling in the CRM** — Setup → General → Calendar Booking: create a 30-minute page,
   then replace the Calendly URL in `frontend/src/layouts/Layout.astro` (`Calendly.initPopupWidget`),
   drop the Calendly script/CSS and CSP hosts in `frontend/src/middleware.ts`, add the link to the
   contact auto-reply and success panel. Booked meetings then attach to the Lead.
4. **Newsletter sending** — Setup → Marketplace → Zoho → Zoho Campaigns; sync by the `newsletter`
   and `resource-download` tags. Subscribers currently receive only the welcome mail.
5. **Zoho SalesIQ visitor tracking (optional)** — Setup → Channels → Chat; paste the widget code and
   it is loaded behind the analytics consent with its hosts added to the CSP.
6. **Assignment rule** when a second sales user joins (see top of this file).
7. **Trial ends 2026-10-08** — pick a paid plan before then; on lapse the site keeps working and
   leads queue in Supabase until the resync catches up.

## LinkedIn ad leads (added 2026-09-25)

**Into Zoho (owner, one-time):** Zoho CRM → Setup → Marketplace → All → search "LinkedIn Lead Gen
Forms" → Install → Authorise with the LinkedIn account that administers the Underwings Page and
the Campaign Manager ad account (needs the *Lead Gen Forms Manager* role) → select the ad account
and forms → map fields: First name → First_Name, Last name → Last_Name, Work email → Email,
Company → Company, Job title → Designation, Phone → Phone, Campaign name → UTM_Campaign, and set
Lead Source to a value containing "LinkedIn" (add the picklist value `LinkedIn` first, as was
done for `Website`). Assign to Manoj. New form fills then appear as Leads within minutes.

**Onto our side (automatic):** `scripts/linkedin-sync.sh` runs every 15 minutes (cron) and calls
`/api/admin/linkedin-sync` inside the container. It pulls Leads created in the last 3 days via
COQL, keeps those whose Lead Source contains "linkedin" or that carry the `linkedin` tag, and for
each one not yet in Supabase: inserts a `form_submissions` row (`form_type = linkedin_ad`, with
`zoho_lead_id` set so the nightly resync leaves it alone), emails the team ("New LinkedIn ad
lead"), and adds the `linkedin` tag. Idempotent; log at `backups/linkedin-sync.log` (only runs
that mirrored something or failed are written).

**Insight Tag (owner):** Campaign Manager → Analyze → Insight Tag → copy the Partner ID and send it;
it is loaded behind the analytics consent and conversions are defined for contact submit, `/book`
and resource download.
