# Zoho CRM ← underwings.org website leads and traffic

**Date:** 2026-09-24
**Status:** draft for owner review
**Owner decision so far:** "setup website leads, traffic, everything with our CRM" — approved the
outline presented in chat on 2026-09-24.

## 1. Goal

Every visitor who identifies themselves on underwings.org (contact form, coming-soon waitlist,
newsletter signup) becomes a **Lead in Zoho CRM within seconds**, carrying enough context
(service asked for, message, campaign/traffic attribution, page they converted on) that Manoj can
act on it from the CRM without opening anything else. The site's existing behaviour (Supabase
row, Brevo email alert to admin@ + manoj@, visitor auto-reply) stays exactly as it is, so a Zoho
outage never loses a lead or breaks the form.

Success = a real submission through the live form appears in Zoho Leads with all mapped fields
filled, is owned by Manoj, and a repeat submission from the same email updates the same Lead
instead of creating a duplicate.

## 2. What exists today (verified 2026-09-24)

| Piece | State |
|---|---|
| Zoho CRM org | `Underwings Cybersecuirty Solutions` (sic), created today, **Professional trial to 2026-10-08**, 1 user (Manoj, Administrator/CEO), 0 leads, 0 assignment rules |
| Org locale | Currency **INR**, time zone **Asia/Kolkata**, country IN — wrong for a UAE company, must be fixed by the owner before data lands (currency is hard to change later) |
| Leads picklist `Lead_Source` | Has no "Website" value (only Web Download / Web Research / Chat …) |
| Contact form | `frontend/src/pages/api/contact.ts` → Supabase `form_submissions` + auto-reply + team mail |
| Waitlist | `api/waitlist.ts` → Supabase `waitlist_signups` + team mail; rate-limited by IP hash |
| Newsletter | `api/newsletter.ts` → Supabase `subscribers` + welcome mail + team mail; still tries a dead `krayin` webhook (no-op, token unset) |
| Analytics | GA4 `G-YZG3QCH600` behind the site's cookie-consent banner; **no UTM / referrer capture anywhere** |
| Repo | 30-file CRM removal from 2026-09-22 is deployed but **uncommitted** on `main` |
| Existing bug | Contact handler maps the *service* select (`what_can_we_help_with_`) into `message` and never reads `service_interest`, so both stored rows have an empty service and the visitor's real message is dropped when a service is chosen |

## 3. Non-goals

- Replacing the site's forms with Zoho Web Forms (loses design, Turnstile, Supabase copy).
- Deals, quotes, invoices, or any pipeline automation inside Zoho. Leads only.
- Automated outbound. Nothing here sends mail to prospects beyond the existing auto-reply.
- Migrating old CRM data. The 2 historic `form_submissions` rows are back-filled as a one-off
  script run, nothing more.

## 4. Architecture

```
browser ──POST /api/contact|waitlist|newsletter──▶ Astro route (frontend container)
                                                     ├─ Supabase insert          (unchanged)
                                                     ├─ team mail via Brevo      (unchanged)
                                                     ├─ visitor auto-reply       (unchanged)
                                                     └─ zoho.upsertLead(...)     NEW, best-effort
                                                              │
                                                              ▼
                                            lib/zoho.ts  ──OAuth refresh──▶ accounts.zoho.<dc>
                                                         ──POST /crm/v7/Leads/upsert──▶ www.zohoapis.<dc>
```

- **Credential:** a Zoho **Self Client** (server-to-server OAuth). Client ID, client secret and a
  long-lived refresh token live in the gitignored `.env` and are passed to the `frontend` service
  via compose. Access tokens are minted on demand and cached in memory for their lifetime (~1 h).
  The MCP connection used from this chat is for *configuring* Zoho; it is not a runtime credential.
- **Data centre** is configurable (`ZOHO_ACCOUNTS_URL`, `ZOHO_API_URL`) because the org's
  IN locale suggests it may live on the `.in` DC. The owner confirms by reading the URL bar in Zoho.
- **Failure policy:** Zoho errors are logged with the Supabase row id and never change the HTTP
  response to the visitor. A nightly `scripts/zoho-resync.sh` re-pushes any row whose
  `zoho_lead_id` is still NULL, so a Zoho outage is self-healing without alerting noise.
- **Timeouts and retry:** one attempt with an 8 s timeout inside the request, no in-request retry
  (see [[feedback-retry-giveup-needs-backoff]]); the nightly resync is the retry.

## 5. Field mapping

### 5.1 Zoho Leads — custom fields to create (via MCP, one-off)

| API name | Type | Purpose |
|---|---|---|
| `Website_Form` | picklist: Contact, Waitlist, Newsletter | which form converted |
| `Service_Interest` | text(200) | contact select value / waitlist service slug |
| `Waitlist_Year` | picklist: 2027, 2028 | waitlist only |
| `UTM_Source`, `UTM_Medium`, `UTM_Campaign`, `UTM_Term`, `UTM_Content` | text(200) | first-touch attribution |
| `Landing_Page` | URL | first page of the visit |
| `Conversion_Page` | URL | page the form was on |
| `Referrer` | URL | document.referrer at first touch |
| `GA_Client_ID` | text(100) | GA4 `_ga` client id, joins CRM leads to GA4 sessions |
| `Website_Record_ID` | text(64) | Supabase row uuid, for tracing and resync |

Owner adds one picklist value by hand (the MCP has no picklist-edit tool): `Lead_Source` = **Website**.

### 5.2 Per-form mapping

| Zoho field | Contact | Waitlist | Newsletter |
|---|---|---|---|
| `Last_Name` (mandatory) | surname, or full name if single word, or `Unknown` | name or local-part of email | local-part of email |
| `First_Name` | first word | — | — |
| `Email` | email | email | email |
| `Phone` | phone | — | — |
| `Company` | company | company or `Unknown` | `Unknown` |
| `Lead_Source` | Website | Website | Website |
| `Lead_Status` | Not Contacted | Not Contacted | Not Contacted |
| `Website_Form` | Contact | Waitlist | Newsletter |
| `Service_Interest` | service select value | service slug | — |
| `Waitlist_Year` | — | year | — |
| `Description` | the visitor's message (fixing the existing swap bug) | "Joined waitlist for <slug> (<year>) from <page>" | "Newsletter signup from <source>" |
| `Email_Opt_Out` | false | false | false |
| UTM/Landing/Referrer/GA | from attribution cookie | same | same |
| `Website_Record_ID` | form_submissions.id | waitlist_signups.id | subscribers.id |
| `Owner` | Manoj (assignment rule, see §7) | same | same |

Upsert key: `Email` (Zoho `duplicate_check_fields: ["Email"]`). A returning visitor's Lead gets
the newer form's fields and a **Note** appended ("Submitted <form> again on <date>: <details>")
so history is not overwritten.

### 5.3 Attribution capture (client side)

A tiny inline script in `Layout.astro` (already CSP-nonced) runs on every page:

1. If no `uw_attr` cookie: read `utm_*` from the URL, `document.referrer`, `location.pathname`,
   store as JSON in a first-party cookie, 90 days, `SameSite=Lax`. First touch wins.
2. Each form submit reads the cookie plus current `location.pathname` and the `_ga` cookie (if
   consent was given; otherwise blank) and includes them as an `attribution` object in the JSON body.

No new third-party script. The cookie holds no personal data, so it sits outside the consent gate;
only the GA client id is consent-dependent.

### 5.4 Supabase changes

`form_submissions`, `waitlist_signups`, `subscribers` each get `zoho_lead_id text` and
`zoho_synced_at timestamptz`; `form_submissions.metadata` and new `attribution jsonb` on the
other two hold the attribution object. Migration in `supabase/migrations/`, applied with psql,
followed by `NOTIFY pgrst, 'reload schema'` ([[feedback-postgrest-schema-cache]]).

## 6. Traffic in the CRM

Two layers, one shipped now and one owner-gated:

1. **Now:** every Lead carries UTM source/medium/campaign, landing page, referrer and conversion
   page (§5.3). Zoho reports on `UTM_Source`/`Landing_Page` answer "which pages and campaigns
   produce leads" without any extra product.
2. **Owner-gated:** Zoho SalesIQ visitor tracking (free plan: 1 operator, 10k visitors/month,
   integrates with CRM and shows page-by-page visits on the Lead). The owner enables it in Zoho
   CRM Setup → Channels → Chat and pastes the widget code here; I embed it behind the existing
   analytics consent, on the same nonce, and add its hosts to CSP. Not in this build's
   acceptance; documented as the follow-on.

## 7. Zoho-side configuration (via MCP, after approval)

- Create the custom fields in §5.1 on Leads.
- Tags: `website`, `contact-form`, `waitlist`, `newsletter`.
- Assignment rule "Website leads → Manoj" on Leads (single user today; keeps working when a
  second user is added). If the MCP cannot create assignment rules (read tool only), the upsert
  sets `Owner` explicitly to Manoj's user id and the rule is an owner to-do.
- Owner to-dos (cannot be done through the API): fix org currency → AED, time zone → Asia/Dubai,
  company name spelling; add `Lead_Source` value "Website"; create the Self Client.

## 8. Components and files

| File | Change |
|---|---|
| `frontend/src/lib/zoho.ts` | NEW. `getAccessToken()` (refresh-token grant, in-memory cache), `upsertLead(payload)`, `addNote(leadId, text)`. Pure fetch, no SDK. Exports a `buildLead*` mapper per form for testability. |
| `frontend/src/lib/attribution.ts` | NEW. Parses/validates the `attribution` object from a request body (allow-list, length caps). |
| `frontend/src/pages/api/contact.ts` | Fix service/message swap; pass attribution; call `upsertLead` after Supabase insert; write back `zoho_lead_id`. |
| `frontend/src/pages/api/waitlist.ts`, `newsletter.ts` | Same wiring; delete the dead `krayin` webhook code from newsletter. |
| `frontend/src/layouts/Layout.astro` | Attribution cookie script; both newsletter callers send `attribution`. |
| `frontend/src/components/Footer.astro`, `pages/index.astro` | Form submit handlers include `attribution`. |
| `docker-compose.yml` | Pass `ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN/ACCOUNTS_URL/API_URL/OWNER_ID` into `frontend`. |
| `supabase/migrations/2026-09-24-zoho-sync.sql` | §5.4 columns. |
| `scripts/zoho-resync.sh` (+ systemd timer, nightly 03:15 Dubai) | Re-push rows with NULL `zoho_lead_id`; back-fills the 2 historic rows on first run. Exits non-zero and mails ops only if a row is still unsynced after 3 nights. |
| `tests/smoke.sh` | New check: `/api/contact` with a marker email → Lead exists in Zoho with that marker (read via a COQL query using the same credential), then the Lead is deleted. Marker pattern `smoke+<ts>@underwings.org`. |
| `frontend/src/lib/zoho.test.mjs` | node:test unit tests for the mappers (name splitting, empty fields, attribution caps). |
| `docs/runbooks/zoho-crm-website.md` | Credential rotation, DC, how to re-run resync, how to read the Zoho error log line. |

## 9. Error handling

| Failure | Behaviour |
|---|---|
| Zoho credentials missing | `upsertLead` returns `{skipped:true}` and logs once at boot; forms work as today. |
| Refresh-token rejected (revoked/expired) | Log `zoho auth failed` with HTTP status; nightly resync mails ops after 3 consecutive failures. |
| Zoho 4xx on a field (e.g. picklist value missing) | Log the Zoho `details` block verbatim with the Supabase id; row stays unsynced for resync after the fix. |
| Zoho slow/down | 8 s timeout, visitor still gets 200. |
| Duplicate email | Upsert updates + Note; never a second Lead. |
| Attribution cookie tampered | Server allow-lists keys, caps 200 chars, strips control chars; never trusted for anything but display. |

## 10. Testing

1. Unit: mapper tests via `node --test` (gate with a `.mjs` copy, see [[feedback-node-check-esm-gate]]).
2. Local integration: `curl` each route against the running container with a sandbox marker email;
   assert Lead in Zoho via MCP `searchRecords`, then delete.
3. Live: one real submission per form through the browser on underwings.org; confirm Lead, owner,
   fields, Note-on-repeat; screenshot the Zoho record for the owner.
4. Regression: `bash tests/smoke.sh https://underwings.org` must stay green (42 existing + new).
5. Attribution: visit `https://underwings.org/?utm_source=spec-test&utm_medium=qa`, browse two
   pages, submit → Lead shows `UTM_Source=spec-test`, `Landing_Page=/`, `Conversion_Page=/`.

## 11. Rollout

1. Commit the pending CRM-removal working tree as its own commit (it is already what's live).
2. Zoho-side config via MCP (§7) — safe, additive, no site change.
3. Owner completes to-dos in §7 and pastes Self Client values; I write `.env`.
4. Code + migration + compose; `docker compose up -d --build frontend`; check nginx upstream IP
   ([[feedback-nginx-upstream-dns-cache]]).
5. Tests in §10; first resync run back-fills the 2 historic rows.
6. Commit + push `main`; update memory.

Rollback: unset the `ZOHO_*` vars and rebuild — the code path is a no-op without them.

## 12. Open questions for the owner

1. Which Zoho data centre? (URL bar shows `crm.zoho.com`, `crm.zoho.in`, or `crm.zoho.eu`.)
2. Newsletter signups into the CRM as Leads (recommended, tagged so they can be filtered out), or
   keep them out of Zoho entirely?
3. Enable SalesIQ visitor tracking (free tier) as the follow-on, yes/no?
