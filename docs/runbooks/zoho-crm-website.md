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
