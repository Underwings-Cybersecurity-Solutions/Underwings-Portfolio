# Zoho CRM ← Website Leads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every contact, waitlist and newsletter submission on underwings.org is upserted as a Zoho CRM Lead (keyed on email) carrying service, message and first-touch traffic attribution, without changing what the visitor or the team see today.

**Architecture:** A small server-side Zoho client (`frontend/src/lib/zoho.ts`, refresh-token OAuth + `POST /crm/v7/Leads/upsert`) is called best-effort from the three existing Astro API routes after the Supabase write; pure mapper functions (`zoho-leads.ts`) build the payload and are unit-tested; a first-party `uw_attr` cookie captures first-touch UTM/referrer/landing page in the browser and every form sends it as an `attribution` object; a token-protected admin route re-pushes rows whose `zoho_lead_id` is NULL and is run nightly by cron.

**Tech Stack:** Astro 4 (Node adapter, SSR routes), TypeScript, `@supabase/supabase-js`, Zoho CRM REST API v7 (US DC: `accounts.zoho.com`, `www.zohoapis.com`), node:test run in `node:24-alpine` (host has no node), Docker Compose, cron.

**Spec:** `docs/superpowers/specs/2026-09-24-zoho-crm-website-leads-design.md`

## Global Constraints

- Zoho data centre is **.com**: `ZOHO_ACCOUNTS_URL=https://accounts.zoho.com`, `ZOHO_API_URL=https://www.zohoapis.com`.
- Zoho owner user id (Manoj) is `7626271000000625001`; org id `7626271000000020005`.
- Every Zoho call has an **8 s timeout**, no in-request retry; visitor responses never depend on Zoho.
- Credentials only in the gitignored `.env` (repo is PUBLIC). Never in compose literals, never in commits.
- `Lead_Source` must be exactly `Website` (owner adds the picklist value); `Lead_Status` = `Not Contacted`.
- Upsert key is `Email`, normalised `trim().toLowerCase()` before every Zoho call.
- Attribution strings: allow-listed keys only, max 200 chars, control characters stripped.
- Contact route fix: service = `what_can_we_help_with_`, message = `message` (today they are swapped).
- Deploy = `docker compose up -d --build frontend`; compare `frontend` container IP before/after and restart `underwings-nginx` if it changed.
- No published prices, phone stays `+971 54 707 8203`, nothing else on the site changes.
- Tests: `docker run --rm -v "$PWD/frontend:/app" -w /app node:24-alpine node --test 'src/lib/*.test.mjs'` (Node 24 strips TS types natively; test files import `.ts` directly; no enums/namespaces in tested files).
- Commit after every task; `git push origin main` only in the final task.

## Review Focus

1. **Zoho returns HTTP 200 with a per-record error** (`data[0].status === "error"`, e.g. `INVALID_DATA` on a missing picklist value). Expected: treated as failure, logged with `details`, row stays unsynced. Pinned in Task 5.
2. **Single-word or empty names** ("Fatima", ""). Expected: `Last_Name` = the word or `Unknown`, never a rejected mandatory field. Pinned in Task 4.
3. **Repeat submission from the same email** (`action: "update"`). Expected: one Lead, a Note appended with the new details, no second Lead. Pinned in Task 5 (client) and Task 10 (live).
4. **Hostile attribution payload** (unknown keys, 5 KB strings, `\u0000`, non-object). Expected: silently reduced to the safe subset, request still 200. Pinned in Task 3.
5. **Zoho unreachable or credentials absent** (ECONNREFUSED, 401 on refresh, env unset). Expected: visitor gets 200, Supabase row written, one clear log line, resync picks it up. Pinned in Task 5 and Task 9.

---

### Task 1: Commit the deployed-but-uncommitted CRM removal

The working tree holds the 2026-09-22 removal of crm.underwings.org + LeadGen (30 deletions, 8 edits). It is what is live. Everything below builds on it, so it becomes its own commit first.

**Files:**
- Modify: nothing new; commit the existing tree.

- [ ] **Step 1: Confirm the tree is exactly the removal**

Run: `cd /home/deployer/underwings && git status --short | grep -vE '^( D|D ) (crm|leadgen)/' `
Expected: only these paths: `admin/src/index.html`, `backups/scripts/healthcheck.sh`, `docker-compose.yml`, `frontend/src/lib/crm-inbound.ts` (D), `frontend/src/pages/api/brevo-events.ts` (D), `frontend/src/pages/api/contact.ts`, `newsletter.ts`, `waitlist.ts`, `scripts/provision-crm-user.sh` (D), `tests/smoke.sh`, plus the plan file from this task set. If anything else appears, stop and report it.

- [ ] **Step 2: Check no secret is being committed**

Run: `git diff | grep -iE 'password|secret|token' | grep -v '^-' | head`
Expected: no added lines containing credentials (removed lines are fine).

- [ ] **Step 3: Commit**

```bash
git add -A -- admin backups/scripts crm leadgen docker-compose.yml frontend/src scripts/provision-crm-user.sh tests/smoke.sh
git commit -m "chore: remove crm.underwings.org and LeadGen (deployed 2026-09-22)

App, vhost, cert, crm_* DB objects and the LeadGen pipeline were removed on
2026-09-22; the only copy is backups/manual/crm-final-2026-09-22.tar.gz.gpg.
Forms now write to Supabase and notify the team via Brevo only.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git status --short
```
Expected: status shows only the new plan file (committed in Task 12) or nothing.

---

### Task 2: Zoho-side configuration through the MCP

Additive, reversible, no site change. Done from the Claude session with the `zoho-crm` MCP tools.

**Interfaces:**
- Produces: custom field API names used by Task 4 mappers — `Website_Form`, `Service_Interest`, `Resource_Downloaded`, `Waitlist_Year`, `UTM_Source`, `UTM_Medium`, `UTM_Campaign`, `UTM_Term`, `UTM_Content`, `Landing_Page`, `Conversion_Page`, `Referrer`, `GA_Client_ID`, `Website_Record_ID`.

- [ ] **Step 1: Verify the owner added `Website` to Lead_Source**

Call `getFields` with `{"module":"Leads"}`; the result is saved to a file. Run:
`jq -r '.data.fields[]|select(.api_name=="Lead_Source")|.pick_list_values[].display_value' <file> | grep -x Website`
Expected: `Website`. If absent, ask the owner again and continue with the remaining steps; Task 5's live test cannot pass until it exists.

- [ ] **Step 2: Create the custom fields (one call, ≤25 fields)**

Call `createFields` with `query_params {"module":"Leads"}` and body:

```json
{"fields":[
 {"field_label":"Website Form","data_type":"picklist","pick_list_values":[
   {"display_value":"Contact","actual_value":"Contact"},
   {"display_value":"Waitlist","actual_value":"Waitlist"},
   {"display_value":"Newsletter","actual_value":"Newsletter"},
   {"display_value":"Resource Download","actual_value":"Resource Download"}]},
 {"field_label":"Service Interest","data_type":"text","length":200},
 {"field_label":"Resource Downloaded","data_type":"text","length":200},
 {"field_label":"Waitlist Year","data_type":"picklist","pick_list_values":[
   {"display_value":"2027","actual_value":"2027"},{"display_value":"2028","actual_value":"2028"}]},
 {"field_label":"UTM Source","data_type":"text","length":200},
 {"field_label":"UTM Medium","data_type":"text","length":200},
 {"field_label":"UTM Campaign","data_type":"text","length":200},
 {"field_label":"UTM Term","data_type":"text","length":200},
 {"field_label":"UTM Content","data_type":"text","length":200},
 {"field_label":"Landing Page","data_type":"website"},
 {"field_label":"Conversion Page","data_type":"website"},
 {"field_label":"Referrer","data_type":"website"},
 {"field_label":"GA Client ID","data_type":"text","length":100},
 {"field_label":"Website Record ID","data_type":"text","length":64}
]}
```
Expected: 14 × `"code":"SUCCESS"`.

- [ ] **Step 3: Verify the generated API names**

Re-run `getFields` and: `jq -r '.data.fields[]|select(.custom_field==true)|.api_name' <file>`
Expected: the 14 names listed under Interfaces (plus the pre-existing `Lead_Status_Modified_Time`). If Zoho generated a different name (e.g. `GA_Client_Id`), record the real name and use it in Task 4 — the mapper module holds them in one `FIELD` constant for this reason.

- [ ] **Step 4: Create tags (one per call, the tool accepts one item)**

Call `createTags` five times with `query_params {"module":"Leads"}` and bodies `{"tags":[{"name":"website","color_code":"#24d758"}]}`, `{"tags":[{"name":"contact-form"}]}`, `{"tags":[{"name":"waitlist"}]}`, `{"tags":[{"name":"newsletter"}]}`, `{"tags":[{"name":"resource-download"}]}`.
Expected: each `"code":"SUCCESS"`.

- [ ] **Step 5: Record in the runbook**

Append to `docs/runbooks/zoho-crm-website.md` (create it): the org id, owner user id, the 14 field API names, and the sentence "Assignment rules cannot be created through the MCP; the website sets `Owner` explicitly. When a second sales user joins, create a Leads assignment rule in Setup → Automation → Assignment and set `ZOHO_ASSIGNMENT_RULE_ID`."

```bash
git add docs/runbooks/zoho-crm-website.md
git commit -m "docs(runbook): Zoho CRM website integration — org ids and custom fields

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Attribution parsing (server) + Supabase columns

**Files:**
- Create: `frontend/src/lib/attribution.ts`
- Create: `frontend/src/lib/attribution.test.mjs`
- Create: `supabase/migrations/023_zoho_sync.sql`

**Interfaces:**
- Produces:
  ```ts
  export interface Attribution {
    utm_source?: string; utm_medium?: string; utm_campaign?: string;
    utm_term?: string; utm_content?: string;
    landing_page?: string; conversion_page?: string; referrer?: string; ga_client_id?: string;
  }
  export function parseAttribution(input: unknown): Attribution  // never throws, returns {} on junk
  ```

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/attribution.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAttribution } from './attribution.ts';

test('keeps only allow-listed string keys', () => {
  const a = parseAttribution({ utm_source: 'linkedin', evil: 'x', utm_medium: 42, referrer: 'https://a.b/' });
  assert.deepEqual(a, { utm_source: 'linkedin', referrer: 'https://a.b/' });
});

test('caps at 200 chars and strips control characters', () => {
  const a = parseAttribution({ utm_campaign: 'a\u0000b\u001fc' + 'x'.repeat(500) });
  assert.equal(a.utm_campaign.length, 200);
  assert.ok(!/[\u0000-\u001f]/.test(a.utm_campaign));
  assert.ok(a.utm_campaign.startsWith('abcx'));
});

test('returns {} for non-objects and drops empty strings', () => {
  assert.deepEqual(parseAttribution(null), {});
  assert.deepEqual(parseAttribution('str'), {});
  assert.deepEqual(parseAttribution([1]), {});
  assert.deepEqual(parseAttribution({ utm_source: '   ' }), {});
});

test('url-ish fields must be a path or http(s) URL', () => {
  const a = parseAttribution({ landing_page: '/services?x=1', referrer: 'javascript:alert(1)', conversion_page: 'https://underwings.org/ar' });
  assert.deepEqual(a, { landing_page: '/services?x=1', conversion_page: 'https://underwings.org/ar' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/deployer/underwings && docker run --rm -v "$PWD/frontend:/app" -w /app node:24-alpine node --test src/lib/attribution.test.mjs`
Expected: FAIL, `Cannot find module './attribution.ts'`.

- [ ] **Step 3: Implement**

`frontend/src/lib/attribution.ts`:
```ts
/**
 * First-touch traffic attribution sent by the browser with every form post.
 * Untrusted input: allow-list keys, cap length, strip control chars.
 */
export interface Attribution {
  utm_source?: string; utm_medium?: string; utm_campaign?: string;
  utm_term?: string; utm_content?: string;
  landing_page?: string; conversion_page?: string; referrer?: string;
  ga_client_id?: string;
}

const TEXT_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ga_client_id'] as const;
const URL_KEYS = ['landing_page', 'conversion_page', 'referrer'] as const;
const MAX = 200;

function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX);
  return s.length ? s : null;
}

function cleanUrl(v: unknown): string | null {
  const s = clean(v);
  if (!s) return null;
  return s.startsWith('/') || /^https?:\/\//i.test(s) ? s : null;
}

export function parseAttribution(input: unknown): Attribution {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const src = input as Record<string, unknown>;
  const out: Attribution = {};
  for (const k of TEXT_KEYS) { const v = clean(src[k]); if (v) out[k] = v; }
  for (const k of URL_KEYS) { const v = cleanUrl(src[k]); if (v) out[k] = v; }
  return out;
}
```

- [ ] **Step 4: Run tests**

Same command. Expected: 4 pass.

- [ ] **Step 5: Migration**

`supabase/migrations/023_zoho_sync.sql`:
```sql
-- 023_zoho_sync.sql — Zoho CRM lead sync bookkeeping + traffic attribution.
-- zoho_lead_id NULL == not yet in Zoho; /api/admin/zoho-resync re-pushes those.
ALTER TABLE public.form_submissions
  ADD COLUMN IF NOT EXISTS zoho_lead_id text,
  ADD COLUMN IF NOT EXISTS zoho_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS zoho_error text;
ALTER TABLE public.waitlist_signups
  ADD COLUMN IF NOT EXISTS attribution jsonb,
  ADD COLUMN IF NOT EXISTS zoho_lead_id text,
  ADD COLUMN IF NOT EXISTS zoho_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS zoho_error text;
ALTER TABLE public.subscribers
  ADD COLUMN IF NOT EXISTS attribution jsonb,
  ADD COLUMN IF NOT EXISTS zoho_lead_id text,
  ADD COLUMN IF NOT EXISTS zoho_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS zoho_error text;
CREATE INDEX IF NOT EXISTS form_submissions_zoho_pending ON public.form_submissions (created_at) WHERE zoho_lead_id IS NULL;
CREATE INDEX IF NOT EXISTS waitlist_signups_zoho_pending ON public.waitlist_signups (created_at) WHERE zoho_lead_id IS NULL;
CREATE INDEX IF NOT EXISTS subscribers_zoho_pending ON public.subscribers (id) WHERE zoho_lead_id IS NULL;
NOTIFY pgrst, 'reload schema';
```
(`form_submissions` already has `metadata jsonb`; attribution goes there under key `attribution`.)

- [ ] **Step 6: Apply and verify**

Run:
```bash
docker exec -i underwings-db psql -U postgres -d underwings -v ON_ERROR_STOP=1 < supabase/migrations/023_zoho_sync.sql
docker exec underwings-db psql -U postgres -d underwings -Atc "select table_name, count(*) from information_schema.columns where column_name='zoho_lead_id' group by 1"
```
Expected: three tables, 1 each. Then confirm PostgREST sees it: `curl -s -H "apikey: $ANON" "http://127.0.0.1:8000/rest/v1/waitlist_signups?select=zoho_lead_id&limit=0"` (kong port from compose) returns `[]`, not a 400 about an unknown column. Note `subscribers` has no `created_at` (verified) — the pending index uses `id`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/attribution.ts frontend/src/lib/attribution.test.mjs supabase/migrations/023_zoho_sync.sql
git commit -m "feat(leads): attribution parser and Zoho sync columns

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Lead mappers (pure functions)

**Files:**
- Create: `frontend/src/lib/zoho-leads.ts`
- Create: `frontend/src/lib/zoho-leads.test.mjs`

**Interfaces:**
- Consumes: `Attribution` from Task 3.
- Produces:
  ```ts
  export const FIELD: Record<string,string>            // custom field API names from Task 2
  export function splitName(full: string|null|undefined): { First_Name?: string; Last_Name: string }
  export function normaliseEmail(e: string): string
  export interface ContactInput { name?: string|null; email: string; phone?: string|null; company?: string|null; service?: string|null; message?: string|null; recordId: string; attribution: Attribution }
  export interface WaitlistInput { name?: string|null; email: string; company?: string|null; serviceSlug: string; year?: string|null; sourcePage?: string|null; recordId: string; attribution: Attribution }
  export interface NewsletterInput { email: string; source: string; recordId: string; attribution: Attribution }
  export function buildContactLead(i: ContactInput, ownerId: string): Record<string, unknown>
  export function buildWaitlistLead(i: WaitlistInput, ownerId: string): Record<string, unknown>
  export function buildNewsletterLead(i: NewsletterInput, ownerId: string): Record<string, unknown>
  export function repeatNote(form: 'Contact'|'Waitlist'|'Newsletter', details: string, when?: Date): string
  ```

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/zoho-leads.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitName, normaliseEmail, buildContactLead, buildWaitlistLead, buildNewsletterLead, repeatNote, FIELD } from './zoho-leads.ts';

const OWNER = '7626271000000625001';

test('splitName: two words, one word, empty', () => {
  assert.deepEqual(splitName('Fatima Al Mansoori'), { First_Name: 'Fatima', Last_Name: 'Al Mansoori' });
  assert.deepEqual(splitName('Fatima'), { Last_Name: 'Fatima' });
  assert.deepEqual(splitName(''), { Last_Name: 'Unknown' });
  assert.deepEqual(splitName(null), { Last_Name: 'Unknown' });
  assert.equal(splitName('A'.repeat(100) + ' ' + 'B'.repeat(100)).Last_Name.length, 80);
});

test('normaliseEmail trims and lowercases', () => {
  assert.equal(normaliseEmail('  Ahmed@Example.COM '), 'ahmed@example.com');
});

test('contact lead: full mapping, message in Description, service in Service_Interest', () => {
  const lead = buildContactLead({
    name: 'Ahmed Khan', email: 'Ahmed@Example.com', phone: '+971 50 123 4567', company: 'ACME LLC',
    service: 'ptaas', message: 'We need a pentest before Q4.', recordId: 'uuid-1',
    attribution: { utm_source: 'linkedin', landing_page: '/services/ptaas', conversion_page: '/', referrer: 'https://www.linkedin.com/' },
  }, OWNER);
  assert.equal(lead.First_Name, 'Ahmed');
  assert.equal(lead.Last_Name, 'Khan');
  assert.equal(lead.Email, 'ahmed@example.com');
  assert.equal(lead.Phone, '+971 50 123 4567');
  assert.equal(lead.Company, 'ACME LLC');
  assert.equal(lead.Lead_Source, 'Website');
  assert.equal(lead.Lead_Status, 'Not Contacted');
  assert.equal(lead.Description, 'We need a pentest before Q4.');
  assert.equal(lead[FIELD.serviceInterest], 'ptaas');
  assert.equal(lead[FIELD.websiteForm], 'Contact');
  assert.equal(lead[FIELD.utmSource], 'linkedin');
  assert.equal(lead[FIELD.landingPage], 'https://underwings.org/services/ptaas');
  assert.equal(lead[FIELD.conversionPage], 'https://underwings.org/');
  assert.equal(lead[FIELD.referrer], 'https://www.linkedin.com/');
  assert.equal(lead[FIELD.websiteRecordId], 'uuid-1');
  assert.deepEqual(lead.Owner, { id: OWNER });
  assert.equal(lead.Email_Opt_Out, false);
  assert.deepEqual(lead.Tag, [{ name: 'website' }, { name: 'contact-form' }]);
  assert.ok(!('Waitlist_Year' in lead));
});

test('contact lead: missing optionals produce Unknown company and no phone key', () => {
  const lead = buildContactLead({ email: 'x@y.z', recordId: 'r', attribution: {} }, OWNER);
  assert.equal(lead.Company, 'Unknown');
  assert.equal(lead.Last_Name, 'Unknown');
  assert.ok(!('Phone' in lead));
  assert.ok(!('Description' in lead));
  assert.equal(lead.Phone, undefined);
});

test('contact lead: phone capped at 30, description at 32000', () => {
  const lead = buildContactLead({ email: 'x@y.z', phone: '1'.repeat(50), message: 'm'.repeat(40000), recordId: 'r', attribution: {} }, OWNER);
  assert.equal(lead.Phone.length, 30);
  assert.equal(lead.Description.length, 32000);
});

test('waitlist lead', () => {
  const lead = buildWaitlistLead({ email: 'w@x.y', serviceSlug: 'soc-mdr', year: '2027', sourcePage: '/services/soc-mdr', recordId: 'w1', attribution: {} }, OWNER);
  assert.equal(lead.Last_Name, 'W');
  assert.equal(lead.Company, 'Unknown');
  assert.equal(lead[FIELD.websiteForm], 'Waitlist');
  assert.equal(lead[FIELD.serviceInterest], 'soc-mdr');
  assert.equal(lead[FIELD.waitlistYear], '2027');
  assert.equal(lead[FIELD.conversionPage], 'https://underwings.org/services/soc-mdr');
  assert.equal(lead.Description, 'Joined the waitlist for soc-mdr (2027) from /services/soc-mdr');
  assert.deepEqual(lead.Tag, [{ name: 'website' }, { name: 'waitlist' }]);
});

test('waitlist lead: name given, no year', () => {
  const lead = buildWaitlistLead({ name: 'Sara Q', company: 'Gulf Co', email: 'w@x.y', serviceSlug: 'dfir', recordId: 'w2', attribution: {} }, OWNER);
  assert.equal(lead.First_Name, 'Sara');
  assert.equal(lead.Company, 'Gulf Co');
  assert.ok(!(FIELD.waitlistYear in lead));
  assert.equal(lead.Description, 'Joined the waitlist for dfir');
});

test('resource download: lead magnet source → Resource Download form + Resource_Downloaded', () => {
  const lead = buildNewsletterLead({ email: 'john.doe@corp.ae', source: 'lead_magnet:Security Assessment Checklist', recordId: 'n1', attribution: { ga_client_id: '123.456' } }, OWNER);
  assert.equal(lead.Last_Name, 'John Doe');
  assert.equal(lead[FIELD.websiteForm], 'Resource Download');
  assert.equal(lead[FIELD.resourceDownloaded], 'Security Assessment Checklist');
  assert.equal(lead.Lead_Status, 'Contact in Future');
  assert.equal(lead.Description, 'Downloaded "Security Assessment Checklist" from the website');
  assert.equal(lead[FIELD.gaClientId], '123.456');
  assert.deepEqual(lead.Tag, [{ name: 'website' }, { name: 'resource-download' }]);
});

test('plain newsletter signup', () => {
  const lead = buildNewsletterLead({ email: 'x@y.z', source: 'newsletter', recordId: 'n2', attribution: {} }, OWNER);
  assert.equal(lead[FIELD.websiteForm], 'Newsletter');
  assert.equal(lead.Lead_Status, 'Contact in Future');
  assert.ok(!(FIELD.resourceDownloaded in lead));
  assert.deepEqual(lead.Tag, [{ name: 'website' }, { name: 'newsletter' }]);
});

test('repeatNote is dated and names the form', () => {
  const n = repeatNote('Contact', 'Service: vapt\nMessage: hi', new Date('2026-09-24T10:00:00Z'));
  assert.match(n, /^Submitted the Contact form again on 24 Sep 2026/);
  assert.ok(n.endsWith('Service: vapt\nMessage: hi'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker run --rm -v "$PWD/frontend:/app" -w /app node:24-alpine node --test src/lib/zoho-leads.test.mjs`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

`frontend/src/lib/zoho-leads.ts`:
```ts
/**
 * Pure mappers: website form data → Zoho CRM Lead payload.
 * No I/O here so the mapping is unit-testable. FIELD holds the custom field
 * API names created on 2026-09-24 (see docs/runbooks/zoho-crm-website.md);
 * if Zoho ever generates a different name, change it in one place.
 */
import type { Attribution } from './attribution';

export const FIELD = {
  websiteForm: 'Website_Form',
  serviceInterest: 'Service_Interest',
  resourceDownloaded: 'Resource_Downloaded',
  waitlistYear: 'Waitlist_Year',
  utmSource: 'UTM_Source',
  utmMedium: 'UTM_Medium',
  utmCampaign: 'UTM_Campaign',
  utmTerm: 'UTM_Term',
  utmContent: 'UTM_Content',
  landingPage: 'Landing_Page',
  conversionPage: 'Conversion_Page',
  referrer: 'Referrer',
  gaClientId: 'GA_Client_ID',
  websiteRecordId: 'Website_Record_ID',
} as const;

const SITE = 'https://underwings.org';
const LIMITS = { first: 40, last: 80, company: 200, phone: 30, description: 32000, text: 200 };

export interface ContactInput { name?: string | null; email: string; phone?: string | null; company?: string | null; service?: string | null; message?: string | null; recordId: string; attribution: Attribution }
export interface WaitlistInput { name?: string | null; email: string; company?: string | null; serviceSlug: string; year?: string | null; sourcePage?: string | null; recordId: string; attribution: Attribution }
export interface NewsletterInput { email: string; source: string; recordId: string; attribution: Attribution }

const cut = (s: string, n: number) => s.slice(0, n);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function normaliseEmail(e: string): string { return e.trim().toLowerCase(); }

export function splitName(full: string | null | undefined): { First_Name?: string; Last_Name: string } {
  const s = str(full);
  if (!s) return { Last_Name: 'Unknown' };
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { Last_Name: cut(parts[0], LIMITS.last) };
  return { First_Name: cut(parts[0], LIMITS.first), Last_Name: cut(parts.slice(1).join(' '), LIMITS.last) };
}

function nameFromEmail(email: string): string {
  const local = email.split('@')[0] || 'Unknown';
  return cut(local.replace(/[._+-]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()) || 'Unknown', LIMITS.last);
}

function absolute(p: string | undefined): string | undefined {
  if (!p) return undefined;
  return p.startsWith('/') ? SITE + p : p;
}

function attributionFields(a: Attribution): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (a.utm_source) out[FIELD.utmSource] = cut(a.utm_source, LIMITS.text);
  if (a.utm_medium) out[FIELD.utmMedium] = cut(a.utm_medium, LIMITS.text);
  if (a.utm_campaign) out[FIELD.utmCampaign] = cut(a.utm_campaign, LIMITS.text);
  if (a.utm_term) out[FIELD.utmTerm] = cut(a.utm_term, LIMITS.text);
  if (a.utm_content) out[FIELD.utmContent] = cut(a.utm_content, LIMITS.text);
  if (a.landing_page) out[FIELD.landingPage] = absolute(a.landing_page);
  if (a.conversion_page) out[FIELD.conversionPage] = absolute(a.conversion_page);
  if (a.referrer) out[FIELD.referrer] = a.referrer;
  if (a.ga_client_id) out[FIELD.gaClientId] = cut(a.ga_client_id, 100);
  return out;
}

function base(form: 'Contact' | 'Waitlist' | 'Newsletter' | 'Resource Download', tag: string, email: string, recordId: string, ownerId: string, a: Attribution) {
  return {
    Email: normaliseEmail(email),
    Lead_Source: 'Website',
    Lead_Status: 'Not Contacted',
    Email_Opt_Out: false,
    Owner: { id: ownerId },
    Tag: [{ name: 'website' }, { name: tag }],
    [FIELD.websiteForm]: form,
    [FIELD.websiteRecordId]: cut(recordId, 64),
    ...attributionFields(a),
  } as Record<string, unknown>;
}

export function buildContactLead(i: ContactInput, ownerId: string): Record<string, unknown> {
  const lead = { ...base('Contact', 'contact-form', i.email, i.recordId, ownerId, i.attribution), ...splitName(i.name) };
  lead.Company = cut(str(i.company) || 'Unknown', LIMITS.company);
  const phone = str(i.phone); if (phone) lead.Phone = cut(phone, LIMITS.phone);
  const service = str(i.service); if (service) lead[FIELD.serviceInterest] = cut(service, LIMITS.text);
  const message = str(i.message); if (message) lead.Description = cut(message, LIMITS.description);
  return lead;
}

export function buildWaitlistLead(i: WaitlistInput, ownerId: string): Record<string, unknown> {
  const lead = base('Waitlist', 'waitlist', i.email, i.recordId, ownerId, i.attribution);
  Object.assign(lead, str(i.name) ? splitName(i.name) : { Last_Name: nameFromEmail(normaliseEmail(i.email)) });
  lead.Company = cut(str(i.company) || 'Unknown', LIMITS.company);
  lead[FIELD.serviceInterest] = cut(i.serviceSlug, LIMITS.text);
  const year = str(i.year); if (year) lead[FIELD.waitlistYear] = year;
  const page = str(i.sourcePage);
  if (page && !lead[FIELD.conversionPage]) lead[FIELD.conversionPage] = absolute(page);
  lead.Description = `Joined the waitlist for ${i.serviceSlug}` + (year ? ` (${year})` : '') + (page ? ` from ${page}` : '');
  return lead;
}

export function buildNewsletterLead(i: NewsletterInput, ownerId: string): Record<string, unknown> {
  // source is 'newsletter' or 'lead_magnet:<resource name>' (set by api/newsletter.ts)
  const magnet = i.source.startsWith('lead_magnet:') ? i.source.slice('lead_magnet:'.length).trim() : null;
  const lead = magnet
    ? base('Resource Download', 'resource-download', i.email, i.recordId, ownerId, i.attribution)
    : base('Newsletter', 'newsletter', i.email, i.recordId, ownerId, i.attribution);
  lead.Last_Name = nameFromEmail(normaliseEmail(i.email));
  lead.Company = 'Unknown';
  // Marketing leads are nurtured, not called: keep them out of the "Not Contacted" queue.
  lead.Lead_Status = 'Contact in Future';
  if (magnet) { lead[FIELD.resourceDownloaded] = cut(magnet, LIMITS.text); lead.Description = `Downloaded "${cut(magnet, LIMITS.text)}" from the website`; }
  else lead.Description = 'Newsletter signup from the website';
  return lead;
}

export function repeatNote(form: 'Contact' | 'Waitlist' | 'Newsletter', details: string, when: Date = new Date()): string {
  const date = when.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Submitted the ${form} form again on ${date} (Dubai)\n\n${details}`;
}
```

- [ ] **Step 4: Run tests**

Expected: all pass. If `repeatNote` date format differs by locale data in alpine (`24 Sept 2026` vs `24 Sep 2026`), loosen the regex to `/24 Sept? 2026/` — the content, not the abbreviation, is the contract.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/zoho-leads.ts frontend/src/lib/zoho-leads.test.mjs
git commit -m "feat(leads): pure Zoho Lead mappers for contact, waitlist, newsletter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Zoho client (OAuth refresh + upsert + note)

**Files:**
- Create: `frontend/src/lib/zoho.ts`
- Create: `frontend/src/lib/zoho.test.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface ZohoEnv { clientId?: string; clientSecret?: string; refreshToken?: string; accountsUrl?: string; apiUrl?: string; ownerId?: string }
  export interface UpsertResult { ok: true; id: string; action: 'insert'|'update' } | { ok: false; skipped?: true; error: string }
  export function createZohoClient(opts?: { env?: ZohoEnv; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }): {
    enabled: boolean; ownerId: string;
    upsertLead(lead: Record<string, unknown>): Promise<UpsertResult>;
    addNote(leadId: string, title: string, content: string): Promise<boolean>;
  }
  export const zoho: ReturnType<typeof createZohoClient>   // default instance from process.env
  ```

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/zoho.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZohoClient } from './zoho.ts';

const ENV = { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt', accountsUrl: 'https://acc.test', apiUrl: 'https://api.test', ownerId: 'o1' };

function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = script.shift();
    if (!step) throw new Error('unexpected fetch ' + url);
    if (step.throw) throw step.throw;
    return new Response(JSON.stringify(step.body), { status: step.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

test('disabled when credentials are missing: skipped, no fetch', async () => {
  const f = fakeFetch([]);
  const z = createZohoClient({ env: {}, fetch: f });
  assert.equal(z.enabled, false);
  const r = await z.upsertLead({ Email: 'a@b.c' });
  assert.deepEqual(r, { ok: false, skipped: true, error: 'zoho not configured' });
  assert.equal(f.calls.length, 0);
});

test('refreshes token once, caches it, upserts with duplicate check on Email', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT1', expires_in: 3600 } },
    { body: { data: [{ code: 'SUCCESS', action: 'insert', details: { id: '111' }, status: 'success' }] } },
    { body: { data: [{ code: 'SUCCESS', action: 'update', details: { id: '111' }, status: 'success' }] } },
  ]);
  let t = 1_000_000;
  const z = createZohoClient({ env: ENV, fetch: f, now: () => t });
  const r1 = await z.upsertLead({ Email: 'a@b.c', Last_Name: 'X' });
  assert.deepEqual(r1, { ok: true, id: '111', action: 'insert' });
  const r2 = await z.upsertLead({ Email: 'a@b.c', Last_Name: 'X' });
  assert.deepEqual(r2, { ok: true, id: '111', action: 'update' });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].url, 'https://acc.test/oauth/v2/token');
  assert.match(f.calls[0].init.body, /grant_type=refresh_token/);
  assert.equal(f.calls[1].url, 'https://api.test/crm/v7/Leads/upsert');
  assert.equal(f.calls[1].init.headers.Authorization, 'Zoho-oauthtoken AT1');
  const sent = JSON.parse(f.calls[1].init.body);
  assert.deepEqual(sent.duplicate_check_fields, ['Email']);
  assert.equal(sent.data[0].Email, 'a@b.c');
});

test('re-refreshes after expiry (60 s safety margin)', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT1', expires_in: 3600 } },
    { body: { data: [{ code: 'SUCCESS', action: 'insert', details: { id: '1' } }] } },
    { body: { access_token: 'AT2', expires_in: 3600 } },
    { body: { data: [{ code: 'SUCCESS', action: 'insert', details: { id: '2' } }] } },
  ]);
  let t = 0;
  const z = createZohoClient({ env: ENV, fetch: f, now: () => t });
  await z.upsertLead({ Email: 'a@b.c' });
  t = 3600_000 - 30_000; // inside the margin → must refresh
  await z.upsertLead({ Email: 'a@b.c' });
  assert.equal(f.calls[3].init.headers.Authorization, 'Zoho-oauthtoken AT2');
});

test('HTTP 200 with per-record error is a failure with details', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT1', expires_in: 3600 } },
    { body: { data: [{ code: 'INVALID_DATA', status: 'error', message: 'invalid data', details: { api_name: 'Lead_Source', expected_data_type: 'picklist' } }] } },
  ]);
  const z = createZohoClient({ env: ENV, fetch: f });
  const r = await z.upsertLead({ Email: 'a@b.c' });
  assert.equal(r.ok, false);
  assert.match(r.error, /INVALID_DATA/);
  assert.match(r.error, /Lead_Source/);
});

test('token endpoint error and network error both return ok:false, never throw', async () => {
  const z1 = createZohoClient({ env: ENV, fetch: fakeFetch([{ status: 400, body: { error: 'invalid_code' } }]) });
  const r1 = await z1.upsertLead({ Email: 'a@b.c' });
  assert.equal(r1.ok, false); assert.match(r1.error, /token/);
  const z2 = createZohoClient({ env: ENV, fetch: fakeFetch([{ throw: new Error('ECONNREFUSED') }]) });
  const r2 = await z2.upsertLead({ Email: 'a@b.c' });
  assert.equal(r2.ok, false); assert.match(r2.error, /ECONNREFUSED/);
});

test('failed token fetch is not cached: next call retries the refresh', async () => {
  const f = fakeFetch([
    { status: 500, body: {} },
    { body: { access_token: 'AT1', expires_in: 3600 } },
    { body: { data: [{ code: 'SUCCESS', action: 'insert', details: { id: '9' } }] } },
  ]);
  const z = createZohoClient({ env: ENV, fetch: f });
  assert.equal((await z.upsertLead({ Email: 'a@b.c' })).ok, false);
  assert.equal((await z.upsertLead({ Email: 'a@b.c' })).ok, true);
});

test('addNote posts to Notes with the parent lead', async () => {
  const f = fakeFetch([
    { body: { access_token: 'AT1', expires_in: 3600 } },
    { body: { data: [{ code: 'SUCCESS', details: { id: 'n1' } }] } },
  ]);
  const z = createZohoClient({ env: ENV, fetch: f });
  assert.equal(await z.addNote('111', 'Repeat', 'body'), true);
  assert.equal(f.calls[1].url, 'https://api.test/crm/v7/Notes');
  const sent = JSON.parse(f.calls[1].init.body);
  assert.deepEqual(sent.data[0].Parent_Id, { module: { api_name: 'Leads' }, id: '111' });
  assert.equal(sent.data[0].Note_Title, 'Repeat');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `docker run --rm -v "$PWD/frontend:/app" -w /app node:24-alpine node --test src/lib/zoho.test.mjs`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

`frontend/src/lib/zoho.ts`:
```ts
/**
 * Minimal Zoho CRM v7 client for the website: refresh-token OAuth (Self Client),
 * Leads upsert keyed on Email, and Notes. Never throws; every failure is an
 * { ok:false, error } the caller logs. Timeouts are hard (8 s) because this runs
 * inside the visitor's request. See docs/runbooks/zoho-crm-website.md.
 */
export interface ZohoEnv { clientId?: string; clientSecret?: string; refreshToken?: string; accountsUrl?: string; apiUrl?: string; ownerId?: string }
export type UpsertResult = { ok: true; id: string; action: 'insert' | 'update' } | { ok: false; skipped?: true; error: string };

const MARGIN_MS = 60_000;

export function envFromProcess(): ZohoEnv {
  const e = process.env;
  return {
    clientId: e.ZOHO_CLIENT_ID, clientSecret: e.ZOHO_CLIENT_SECRET, refreshToken: e.ZOHO_REFRESH_TOKEN,
    accountsUrl: e.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com', apiUrl: e.ZOHO_API_URL || 'https://www.zohoapis.com',
    ownerId: e.ZOHO_OWNER_ID,
  };
}

export function createZohoClient(opts: { env?: ZohoEnv; fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
  const env = opts.env ?? envFromProcess();
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const enabled = !!(env.clientId && env.clientSecret && env.refreshToken);
  const accounts = (env.accountsUrl || 'https://accounts.zoho.com').replace(/\/$/, '');
  const api = (env.apiUrl || 'https://www.zohoapis.com').replace(/\/$/, '');
  let token: { value: string; expiresAt: number } | null = null;

  async function call(url: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await doFetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt - MARGIN_MS > now()) return token.value;
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: env.clientId!, client_secret: env.clientSecret!, refresh_token: env.refreshToken! });
    const res = await call(`${accounts}/oauth/v2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new Error(`zoho token refresh failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    token = { value: json.access_token, expiresAt: now() + Number(json.expires_in || 3600) * 1000 };
    return token.value;
  }

  async function post(path: string, payload: unknown): Promise<any> {
    const at = await accessToken();
    const res = await call(`${api}${path}`, { method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${at}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const json: any = await res.json().catch(() => ({}));
    const rec = Array.isArray(json.data) ? json.data[0] : null;
    if (!res.ok || !rec || rec.code !== 'SUCCESS') {
      const summary = rec ? `${rec.code}: ${rec.message || ''} ${JSON.stringify(rec.details || {})}` : `HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`;
      throw new Error(`zoho ${path} failed: ${summary}`);
    }
    return rec;
  }

  return {
    enabled,
    ownerId: env.ownerId || '',
    async upsertLead(lead: Record<string, unknown>): Promise<UpsertResult> {
      if (!enabled) return { ok: false, skipped: true, error: 'zoho not configured' };
      try {
        const rec = await post('/crm/v7/Leads/upsert', { data: [lead], duplicate_check_fields: ['Email'], trigger: ['workflow'] });
        return { ok: true, id: String(rec.details.id), action: rec.action === 'update' ? 'update' : 'insert' };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    async addNote(leadId: string, title: string, content: string): Promise<boolean> {
      if (!enabled) return false;
      try {
        await post('/crm/v7/Notes', { data: [{ Note_Title: title.slice(0, 120), Note_Content: content.slice(0, 32000), Parent_Id: { module: { api_name: 'Leads' }, id: leadId } }] });
        return true;
      } catch (e: any) {
        console.error('[zoho] addNote failed:', e?.message || e);
        return false;
      }
    },
  };
}

export const zoho = createZohoClient();
if (!zoho.enabled) console.warn('[zoho] ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN not set — website leads will not reach Zoho CRM');
```

- [ ] **Step 4: Run tests**

Expected: 7 pass. (`Response` and `AbortController` are globals in Node 24.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/zoho.ts frontend/src/lib/zoho.test.mjs
git commit -m "feat(leads): Zoho CRM client — refresh-token auth, Leads upsert, Notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Wire the contact route (and fix the service/message swap)

**Files:**
- Modify: `frontend/src/pages/api/contact.ts` — the field extraction block (`const email = fields.email; …`) and the `Promise.all` block.
- Create: `frontend/src/lib/lead-sync.ts` (shared "upsert + write back" helper used by all three routes and the resync route)

**Interfaces:**
- Produces:
  ```ts
  // lead-sync.ts
  export async function syncLead(args: {
    supabase: SupabaseClient | null; table: 'form_submissions'|'waitlist_signups'|'subscribers';
    recordId: string; lead: Record<string, unknown>; form: 'Contact'|'Waitlist'|'Newsletter'; repeatDetails: string;
  }): Promise<UpsertResult>
  ```
  It calls `zoho.upsertLead`, on `update` also `zoho.addNote(id, 'Website: repeat ' + form, repeatNote(form, repeatDetails))`, then updates the row (`zoho_lead_id`, `zoho_synced_at` or `zoho_error`) with the given `supabase` client. Logs one line `[zoho] <table> <recordId> → <id> (<action>)` or `[zoho] <table> <recordId> FAILED: <error>`. Never throws.

- [ ] **Step 1: Create `lead-sync.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { zoho, type UpsertResult } from './zoho';
import { repeatNote } from './zoho-leads';

type Table = 'form_submissions' | 'waitlist_signups' | 'subscribers';
type Form = 'Contact' | 'Waitlist' | 'Newsletter';

export async function syncLead(args: { supabase: SupabaseClient | null; table: Table; recordId: string; lead: Record<string, unknown>; form: Form; repeatDetails: string }): Promise<UpsertResult> {
  const { supabase, table, recordId, lead, form, repeatDetails } = args;
  const result = await zoho.upsertLead(lead);
  if (result.ok) {
    console.log(`[zoho] ${table} ${recordId} → ${result.id} (${result.action})`);
    if (result.action === 'update') await zoho.addNote(result.id, `Website: repeat ${form}`, repeatNote(form, repeatDetails));
  } else if (!result.skipped) {
    console.error(`[zoho] ${table} ${recordId} FAILED: ${result.error}`);
  }
  if (supabase && !(result.ok === false && result.skipped)) {
    const patch = result.ok ? { zoho_lead_id: result.id, zoho_synced_at: new Date().toISOString(), zoho_error: null } : { zoho_error: result.error.slice(0, 1000) };
    const { error } = await supabase.from(table).update(patch).eq('id', recordId);
    if (error) console.error(`[zoho] ${table} ${recordId} write-back failed: ${error.message}`);
  }
  return result;
}
```

- [ ] **Step 2: Edit `contact.ts`**

Add imports at the top:
```ts
import { parseAttribution } from '../../lib/attribution';
import { buildContactLead } from '../../lib/zoho-leads';
import { syncLead } from '../../lib/lead-sync';
import { zoho } from '../../lib/zoho';
```
Replace the extraction block so the swap is fixed and attribution is read:
```ts
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
```
Change the Supabase insert to return the row id and store attribution, then sync after the insert (keep auto-reply + team mail in the same `Promise.all`):
```ts
      const [supabaseResult] = await Promise.all([
        supabase.from('form_submissions').insert({
          form_type: 'contact', name, email, phone, company, message,
          service_interest: service, status: 'new',
          metadata: Object.keys(attribution).length ? { attribution } : null,
        }).select('id').single(),
        sendAutoReply(email, name || 'there', company || undefined, service || undefined, message || undefined),
        notifyTeam(name || 'Unknown', email, phone || undefined, company || undefined, service || undefined, message || undefined),
      ]);

      if (supabaseResult.error) { /* unchanged 500 branch */ }

      const recordId = String(supabaseResult.data.id);
      await syncLead({
        supabase, table: 'form_submissions', recordId, form: 'Contact',
        lead: buildContactLead({ name, email, phone, company, service, message, recordId, attribution }, zoho.ownerId),
        repeatDetails: [service ? `Service: ${service}` : null, company ? `Company: ${company}` : null, phone ? `Phone: ${phone}` : null, message ? `Message:\n${message}` : null].filter(Boolean).join('\n'),
      });
```
Leave the success response as is.

- [ ] **Step 3: Type-check**

Run: `docker run --rm -v "$PWD/frontend:/app" -w /app node:20-alpine sh -c "npx --yes astro check 2>&1 | tail -15"` (uses the project's installed Astro; if `node_modules` is absent on the host, run `npm ci` in the same container first).
Expected: no new errors in `contact.ts`, `lead-sync.ts`, `zoho*.ts`, `attribution.ts`. Pre-existing warnings elsewhere are not this task's problem.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/lead-sync.ts frontend/src/pages/api/contact.ts
git commit -m "feat(contact): push submissions to Zoho CRM; fix service/message swap

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Wire waitlist and newsletter routes

**Files:**
- Modify: `frontend/src/pages/api/waitlist.ts` — the insert (`.insert({...})`) and the block after it.
- Modify: `frontend/src/pages/api/newsletter.ts` — remove `NEWSLETTER_URL`/`NEWSLETTER_TOKEN`/`pushToKeila`; upsert `.select('id')`; sync.

**Interfaces:**
- Consumes: `syncLead`, `buildWaitlistLead`, `buildNewsletterLead`, `parseAttribution`, `zoho.ownerId`.

- [ ] **Step 1: waitlist.ts**

Imports: same four as Task 6 but `buildWaitlistLead`. After `const company = sanitize(body.company, MAX_STRING_LEN);` add `const attribution = parseAttribution(body.attribution);`. Change the insert to
```ts
  const { data: row, error } = await supabase
    .from('waitlist_signups')
    .insert({ service_slug: serviceSlug, service_year: serviceYear, email, name, company, source_page: sourcePage, user_agent: userAgent, ip_hash: ipHash, attribution: Object.keys(attribution).length ? attribution : null })
    .select('id').single();
```
Keep the 23505 branch. After the existing fire-and-forget `notifyTeam(...)` add:
```ts
  await syncLead({
    supabase, table: 'waitlist_signups', recordId: String(row.id), form: 'Waitlist',
    lead: buildWaitlistLead({ name, company, email, serviceSlug, year: serviceYear, sourcePage, recordId: String(row.id), attribution }, zoho.ownerId),
    repeatDetails: `Waitlist: ${label}${sourcePage ? `\nPage: ${sourcePage}` : ''}`,
  });
```

- [ ] **Step 2: newsletter.ts**

Delete the `NEWSLETTER_URL`, `NEWSLETTER_TOKEN` constants and the `pushToKeila` function and its call in `Promise.all` (the `krayin` host no longer exists). Add `const attribution = parseAttribution(body.attribution);` after `cleanEmail`. Change the upsert to `.upsert({ email: cleanEmail, subscription_source: source, subscribed: true, attribution: Object.keys(attribution).length ? attribution : undefined }, { onConflict: 'email' }).select('id').single()`. After the error check add:
```ts
    const recordId = String((supabaseResult as any).data?.id ?? cleanEmail);
    await syncLead({
      supabase, table: 'subscribers', recordId, form: 'Newsletter',
      lead: buildNewsletterLead({ email: cleanEmail, source, recordId, attribution }, zoho.ownerId),
      repeatDetails: `Source: ${source}`,
    });
```
`subscribers.id` type: check with `\d public.subscribers`; if it is an integer, `.eq('id', recordId)` in `syncLead` still works (PostgREST coerces).

- [ ] **Step 3: Type-check** — same command as Task 6 Step 3. Expected: clean for the touched files.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/api/waitlist.ts frontend/src/pages/api/newsletter.ts
git commit -m "feat(leads): waitlist and newsletter signups become Zoho Leads; drop dead krayin webhook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Browser-side attribution cookie and form payloads

**Files:**
- Modify: `frontend/src/layouts/Layout.astro` — add one nonced inline script right after the GA consent script (after line ~201); the two newsletter `fetch('/api/newsletter'` bodies (~1478, ~1659).
- Modify: `frontend/src/components/Footer.astro` ~722 (newsletter body).
- Modify: `frontend/src/pages/index.astro` ~2095 (contact payload).
- Modify: `frontend/public/js/waitlist.js` ~37 (waitlist body).

- [ ] **Step 1: Layout script**

Insert after the gtag loader `<script … src="https://www.googletagmanager.com/gtag/js…">`:
```html
  <!-- First-touch attribution for CRM leads: no personal data, first visit wins, 90 days. -->
  <script is:inline nonce={nonce}>
  (function(){
    try {
      var NAME='uw_attr';
      function read(){ var m=document.cookie.match(new RegExp('(?:^|; )'+NAME+'=([^;]*)')); if(!m) return null; try{ return JSON.parse(decodeURIComponent(m[1])); }catch(e){ return null; } }
      var cur=read();
      if(!cur){
        var q=new URLSearchParams(location.search), a={};
        ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'].forEach(function(k){ var v=q.get(k); if(v) a[k]=v.slice(0,200); });
        a.landing_page=(location.pathname+location.search).slice(0,200);
        if(document.referrer && document.referrer.indexOf(location.origin)!==0) a.referrer=document.referrer.slice(0,200);
        document.cookie=NAME+'='+encodeURIComponent(JSON.stringify(a))+'; Max-Age=7776000; Path=/; SameSite=Lax; Secure';
        cur=a;
      }
      window.uwAttribution=function(){
        var a=Object.assign({}, read()||cur||{});
        a.conversion_page=location.pathname.slice(0,200);
        var ga=document.cookie.match(/(?:^|; )_ga=GA\d\.\d\.([^;]+)/); if(ga) a.ga_client_id=ga[1].slice(0,100);
        return a;
      };
    } catch(e) { window.uwAttribution=function(){ return { conversion_page: location.pathname }; }; }
  })();
  </script>
```
(The `_ga` cookie only exists when analytics consent was granted, so the GA id is consent-gated for free.)

- [ ] **Step 2: Form bodies**

- `index.astro` contact payload: after `'cf-turnstile-response': turnstileToken` add `, attribution: (window.uwAttribution ? window.uwAttribution() : {})`.
- `Layout.astro` ×2 and `Footer.astro`: body becomes `JSON.stringify({ email: email, lead_magnet: leadType, attribution: (window.uwAttribution ? window.uwAttribution() : {}) })` (keep each caller's existing `lead_magnet` value; the footer has none).
- `public/js/waitlist.js`: add `attribution: (window.uwAttribution ? window.uwAttribution() : {}),` inside the JSON body.

- [ ] **Step 3: Build locally to catch syntax errors**

Run: `docker compose build frontend 2>&1 | tail -5`
Expected: image builds (Astro build succeeds). Do not `up` yet.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/layouts/Layout.astro frontend/src/components/Footer.astro frontend/src/pages/index.astro frontend/public/js/waitlist.js
git commit -m "feat(site): first-touch attribution cookie sent with every form

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Resync route + cron

**Files:**
- Create: `frontend/src/pages/api/admin/zoho-resync.ts`
- Create: `scripts/zoho-resync.sh`
- Modify: crontab (deployer)

**Interfaces:**
- Consumes: `syncLead`, the three `build*Lead` mappers, `parseAttribution`.
- Produces: `POST /api/admin/zoho-resync` with header `X-Resync-Token: $ZOHO_RESYNC_TOKEN` → `{ scanned, synced, failed, skipped, failures: [{table,id,error}] }`.

- [ ] **Step 1: Route**

```ts
import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { zoho } from '../../../lib/zoho';
import { syncLead } from '../../../lib/lead-sync';
import { parseAttribution } from '../../../lib/attribution';
import { buildContactLead, buildWaitlistLead, buildNewsletterLead } from '../../../lib/zoho-leads';

export const prerender = false;

const url = import.meta.env.PUBLIC_SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN = process.env.ZOHO_RESYNC_TOKEN;
const LIMIT = 50;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}

export const POST: APIRoute = async ({ request }) => {
  const given = request.headers.get('x-resync-token') || '';
  if (!TOKEN || !timingSafeEqual(given, TOKEN)) return new Response('Unauthorized', { status: 401 });
  if (!zoho.enabled) return json({ error: 'zoho not configured' }, 503);
  if (!url || !key) return json({ error: 'supabase not configured' }, 503);
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const out = { scanned: 0, synced: 0, failed: 0, failures: [] as { table: string; id: string; error: string }[] };

  const run = async (table: 'form_submissions' | 'waitlist_signups' | 'subscribers', form: 'Contact' | 'Waitlist' | 'Newsletter', toLead: (r: any) => Record<string, unknown>) => {
    const { data, error } = await supabase.from(table).select('*').is('zoho_lead_id', null).limit(LIMIT);
    if (error) { out.failures.push({ table, id: '-', error: error.message }); return; }
    for (const r of data || []) {
      out.scanned++;
      const res = await syncLead({ supabase, table, recordId: String(r.id), form, lead: toLead(r), repeatDetails: `Back-filled by resync on ${new Date().toISOString()}` });
      if (res.ok) out.synced++; else { out.failed++; out.failures.push({ table, id: String(r.id), error: res.error }); }
    }
  };

  await run('form_submissions', 'Contact', (r) => buildContactLead({ name: r.name, email: r.email, phone: r.phone, company: r.company, service: r.service_interest, message: r.message, recordId: String(r.id), attribution: parseAttribution(r.metadata?.attribution) }, zoho.ownerId));
  await run('waitlist_signups', 'Waitlist', (r) => buildWaitlistLead({ name: r.name, company: r.company, email: r.email, serviceSlug: r.service_slug, year: r.service_year, sourcePage: r.source_page, recordId: String(r.id), attribution: parseAttribution(r.attribution) }, zoho.ownerId));
  await run('subscribers', 'Newsletter', (r) => buildNewsletterLead({ email: r.email, source: r.subscription_source || 'newsletter', recordId: String(r.id), attribution: parseAttribution(r.attribution) }, zoho.ownerId));

  return json(out, out.failed ? 207 : 200);
};

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
```
Rows whose email is missing will fail with a Zoho error and stay pending; that is visible in `failures` and acceptable.

- [ ] **Step 2: Script**

`scripts/zoho-resync.sh`:
```bash
#!/usr/bin/env bash
# Nightly: re-push website rows that never reached Zoho CRM. Runs inside the
# frontend container so the route is never exposed beyond the token check.
set -u
cd "$(dirname "$0")/.."
TOKEN=$(grep -E '^ZOHO_RESYNC_TOKEN=' .env | cut -d= -f2-)
[ -n "$TOKEN" ] || { echo "ZOHO_RESYNC_TOKEN missing in .env"; exit 2; }
OUT=$(docker exec underwings-frontend wget -qO- --header="X-Resync-Token: $TOKEN" --post-data='' http://127.0.0.1:4321/api/admin/zoho-resync 2>&1)
RC=$?
echo "$(date -u +%FT%TZ) rc=$RC $OUT"
# Alert only on repeated failure: 3 consecutive non-zero exits.
STATE=backups/.zoho-resync-fails
if [ $RC -ne 0 ] || echo "$OUT" | grep -q '"failed":[1-9]'; then
  n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STATE"
  if [ "$n" -ge 3 ] && [ -x backups/scripts/send-alert.sh ]; then backups/scripts/send-alert.sh "Zoho resync failing ${n} nights" "$OUT"; fi
  exit 1
fi
rm -f "$STATE"
```
Check whether `backups/scripts/send-alert.sh` (or whatever healthcheck uses to mail) exists; if the alert helper has a different name, call that one — read `backups/scripts/healthcheck.sh` for the mail function and reuse it. `chmod +x scripts/zoho-resync.sh`.

- [ ] **Step 3: Compose + env + cron**

In `docker-compose.yml` `frontend.environment` add:
```yaml
      - ZOHO_CLIENT_ID=${ZOHO_CLIENT_ID}
      - ZOHO_CLIENT_SECRET=${ZOHO_CLIENT_SECRET}
      - ZOHO_REFRESH_TOKEN=${ZOHO_REFRESH_TOKEN}
      - ZOHO_ACCOUNTS_URL=${ZOHO_ACCOUNTS_URL:-https://accounts.zoho.com}
      - ZOHO_API_URL=${ZOHO_API_URL:-https://www.zohoapis.com}
      - ZOHO_OWNER_ID=${ZOHO_OWNER_ID:-7626271000000625001}
      - ZOHO_RESYNC_TOKEN=${ZOHO_RESYNC_TOKEN}
```
Append to `.env` (gitignored): `ZOHO_RESYNC_TOKEN=$(openssl rand -hex 32)`, `ZOHO_OWNER_ID=7626271000000625001`, and set `FORM_NOTIFY_TO=admin@underwings.org,manoj@underwings.org,contact@underwings.org` (owner asked 2026-09-24 that contact@ receives every lead notification; the compose default only lists admin@ and manoj@). The three credentials are added in Task 10 when the owner supplies them.
Cron: `(crontab -l; echo "15 23 * * * /home/deployer/underwings/scripts/zoho-resync.sh >> /home/deployer/underwings/backups/zoho-resync.log 2>&1") | crontab -` (23:15 UTC = 03:15 Dubai).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/api/admin/zoho-resync.ts scripts/zoho-resync.sh docker-compose.yml
git commit -m "feat(leads): nightly Zoho resync route + cron; compose passes ZOHO_* env

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Credentials, deploy, live verification

Blocked on the owner pasting Client ID, Client Secret and the 10-minute grant code from `api-console.zoho.com` (Self Client, scope `ZohoCRM.modules.ALL,ZohoCRM.settings.READ,ZohoCRM.coql.READ`).

- [ ] **Step 1: Exchange the code for a refresh token (within 10 minutes of generation)**

```bash
curl -s -X POST https://accounts.zoho.com/oauth/v2/token \
  -d grant_type=authorization_code -d client_id="$CID" -d client_secret="$SEC" -d code="$CODE" | jq .
```
Expected: JSON with `refresh_token` and `api_domain: "https://www.zohoapis.com"`. If `api_domain` differs, set `ZOHO_API_URL` to it. Append `ZOHO_CLIENT_ID=`, `ZOHO_CLIENT_SECRET=`, `ZOHO_REFRESH_TOKEN=` to `.env` with a heredoc (never echo them into the shell history with `echo`; use `cat >> .env <<'EOF'`). `chmod 600 .env` if not already.

- [ ] **Step 2: Deploy**

```bash
BEFORE=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' underwings-frontend)
docker compose up -d --build frontend
AFTER=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' underwings-frontend)
echo "$BEFORE -> $AFTER"; [ "$BEFORE" = "$AFTER" ] || docker restart underwings-nginx
docker logs underwings-frontend --since 2m 2>&1 | grep -i zoho
```
Expected: no `[zoho] … not set` warning; site answers 200.

- [ ] **Step 3: Live contact submission (marker email)**

```bash
curl -s -X POST https://underwings.org/api/contact -H 'Content-Type: application/json' -d '{"fields":[{"name":"fullname","value":"Zoho Smoke"},{"name":"company","value":"Underwings QA"},{"name":"email","value":"smoke+zoho1@underwings.org"},{"name":"phone","value":"+971 54 707 8203"},{"name":"what_can_we_help_with_","value":"free-assessment"},{"name":"message","value":"Live test of Zoho lead sync"}],"attribution":{"utm_source":"spec-test","utm_medium":"qa","landing_page":"/","conversion_page":"/"}}'
docker logs underwings-frontend --since 1m 2>&1 | grep '\[zoho\]'
```
Expected: `{"success":true}` and a log line `[zoho] form_submissions <uuid> → <id> (insert)`. Then via MCP `searchRecords` on `Leads` with `email=smoke+zoho1@underwings.org`, fields `Full_Name,Company,Lead_Source,Description,Service_Interest,UTM_Source,Landing_Page,Owner`: Description = the message, Service_Interest = `free-assessment`, UTM_Source = `spec-test`, Owner = Manoj.

- [ ] **Step 4: Repeat submission → update + Note**

Re-run the same curl with message `Second message`. Expected log `(update)`; `searchRecords` still returns ONE lead; its Notes related list (MCP `getRelatedRecords` Leads/<id>/Notes) has "Website: repeat Contact".

- [ ] **Step 5: Waitlist + newsletter live**

```bash
curl -s -X POST https://underwings.org/api/waitlist -H 'Content-Type: application/json' -d '{"service_slug":"soc-mdr","email":"smoke+zoho2@underwings.org","year":"2027","source_page":"/services/soc-mdr","attribution":{"utm_source":"spec-test"}}'
curl -s -X POST https://underwings.org/api/newsletter -H 'Content-Type: application/json' -d '{"email":"smoke+zoho3@underwings.org","attribution":{"utm_source":"spec-test"}}'
```
Expected: both 200, two more Leads with `Website_Form` Waitlist / Newsletter. (These send real welcome/team mails to underwings addresses — acceptable once.)

- [ ] **Step 6: Resync back-fills history**

Run `scripts/zoho-resync.sh`. Expected: `scanned` ≥ the two historic contact rows + existing subscribers/waitlist rows, `failed: 0` (or each failure explained). Confirm in Zoho: the 2026-06-26 and 2026-09-08 contact leads exist.

- [ ] **Step 7: Browser test with real UTM**

Open `https://underwings.org/?utm_source=browser-test&utm_medium=qa` in headless Chrome (recipe in memory `feedback_screenshot_headless_verify`), navigate to `/services`, submit the footer newsletter with `smoke+zoho4@underwings.org`. Expected Lead: `UTM_Source=browser-test`, `Landing_Page=https://underwings.org/?utm_source=…`, `Conversion_Page=https://underwings.org/services`.

- [ ] **Step 8: Clean up test leads**

Delete the four `smoke+zoho*` Leads via MCP `deleteRecord`; delete the matching Supabase rows:
`docker exec underwings-db psql -U postgres -d underwings -c "delete from form_submissions where email like 'smoke+zoho%'; delete from waitlist_signups where email like 'smoke+zoho%'; delete from subscribers where email like 'smoke+zoho%';"`

---

### Task 11: Smoke test + runbook + memory

**Files:**
- Modify: `tests/smoke.sh` — add after the newsletter checks.
- Modify: `docs/runbooks/zoho-crm-website.md`.

- [ ] **Step 1: Smoke checks (read-only, no side effects)**

```bash
check_post "Zoho resync — rejects missing token" "$BASE/api/admin/zoho-resync" '{}' 401 ""
check_post "Contact API — junk attribution still validates" "$BASE/api/contact" '{"fields":[],"attribution":"junk","cf-turnstile-response":"invalid-token"}' 403 "CAPTCHA"
```
Run `bash tests/smoke.sh https://underwings.org`. Expected: all pass (44). If `check_post` cannot match an empty body pattern, pass `Unauthorized`.

- [ ] **Step 2: Runbook**

Add sections: *How it works* (one paragraph + the data-flow line from the plan header), *Environment variables* (the 7 `ZOHO_*` names, where they live, that `.env` is gitignored), *Rotate the refresh token* (Self Client → Generate Code → curl exchange → replace `ZOHO_REFRESH_TOKEN` → `docker compose up -d frontend`), *Reading failures* (`docker logs underwings-frontend | grep '\[zoho\]'`, `zoho_error` column, `backups/zoho-resync.log`), *Trial expiry 2026-10-08* (API keeps working on a paid plan; on lapse, leads queue in Supabase and resync catches up), *Follow-on: SalesIQ* (Setup → Channels → Chat; paste widget code; add hosts `salesiq.zohopublic.com`, `*.zohostatic.com` to `script-src`/`connect-src`/`img-src` in `frontend/src/middleware.ts`; load behind the analytics consent flag).

- [ ] **Step 3: Commit**

```bash
git add tests/smoke.sh docs/runbooks/zoho-crm-website.md
git commit -m "test(smoke): Zoho resync auth + attribution hardening; runbook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Push and record

- [ ] **Step 1: Final checks**

Run: `git status --short` (expect clean), `bash tests/smoke.sh https://underwings.org` (green), `docker run --rm -v "$PWD/frontend:/app" -w /app node:24-alpine node --test 'src/lib/*.test.mjs'` (green).

- [ ] **Step 2: Commit the plan and push**

```bash
git add docs/superpowers/plans/2026-09-24-zoho-crm-website-leads.md
git commit -m "docs(plan): Zoho CRM website leads implementation plan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 3: Memory**

Update `project_underwings_site_repo.md` (removal now committed; Zoho sync live; env names) and create `project_underwings_zoho_crm.md` (org id, owner id, trial expiry 2026-10-08, DC .com, field names, resync cron, follow-ons: SalesIQ, assignment rule when a second user joins, owner still to fix time zone + company name spelling). Add both to `MEMORY.md`.

---

### Task 13 (owner-gated follow-ons, documented in the runbook, not part of this build's acceptance)

- [ ] **Meeting scheduling → Zoho Calendar Booking.** Today every "Book a Call" button opens Calendly `https://calendly.com/manoj-underwings/30min` (`Layout.astro:969`), which knows nothing about the CRM. Zoho CRM Professional includes Calendar Booking (Setup → General → Calendar Booking): the owner creates a 30-minute booking page there and pastes the link. Then: replace the Calendly URL with the Zoho booking URL, remove the Calendly widget script/CSS (`Layout.astro` 211–239, 962–970) and its CSP hosts in `middleware.ts`, add Zoho's hosts, and add the booking link to the contact auto-reply and the contact-form success panel. Booked meetings then appear as Meetings on the Lead automatically.
- [ ] **Zoho-side "any lead update" emails to contact@underwings.org.** The website already mails contact@ on every new submission (FORM_NOTIFY_TO). For edits made inside Zoho (status change, owner change, notes) the owner creates one Workflow Rule: Setup → Automation → Workflow Rules → Leads → "Create or Edit" → action Email Notification → recipient `contact@underwings.org`. Not possible through the MCP (no workflow tool).
- [ ] **Newsletter sending.** Subscribers currently receive only the welcome mail; there is no newsletter tool on the box any more. Zoho Campaigns (free tier, syncs with CRM Leads by tag) is the natural home; owner enables it from Zoho CRM Setup → Marketplace → Zoho → Zoho Campaigns and syncs the `newsletter` and `resource-download` tags.

---

### Task 14: Security Assessment Checklist — the promised free resource

Owner approved 2026-09-24 ("do as per your recommendation"). The exit popup promises a 30-item checklist "on its way" to the inbox; nothing is sent. This task makes the promise true and records the download in Zoho as a Resource Download (Task 4's mapper already does that from the `lead_magnet:` source).

**Files:**
- Create: `frontend/src/lib/resources.ts` + `frontend/src/lib/resources.test.mjs`
- Create: `frontend/public/resources/underwings-security-assessment-checklist.html` (source) and `.pdf` (rendered)
- Modify: `frontend/src/pages/api/newsletter.ts` — welcome email gets a download block when the signup names a known resource.
- Modify: `tests/smoke.sh` — PDF served as `application/pdf`.

**Interfaces:**
- Produces: `export function resourceFor(leadMagnet: string|null|undefined): { title: string; url: string; slug: string } | null` — case-insensitive, trims, matches by title or slug; `null` for unknown.

- [ ] **Step 1: Failing test**

`frontend/src/lib/resources.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resourceFor } from './resources.ts';
test('matches the exit-popup title case-insensitively and by slug', () => {
  const r = resourceFor('Security Assessment Checklist');
  assert.equal(r.slug, 'security-assessment-checklist');
  assert.equal(r.url, 'https://underwings.org/resources/underwings-security-assessment-checklist.pdf');
  assert.equal(resourceFor(' security assessment checklist ').slug, 'security-assessment-checklist');
  assert.equal(resourceFor('security-assessment-checklist').slug, 'security-assessment-checklist');
});
test('unknown or empty → null', () => {
  assert.equal(resourceFor('iso-readiness-checklist'), null);
  assert.equal(resourceFor(''), null);
  assert.equal(resourceFor(undefined), null);
});
```
Run: `docker run --rm -v "$PWD/frontend:/app" -w /app node:24-alpine node --test src/lib/resources.test.mjs` → Expected: FAIL, cannot find module.

- [ ] **Step 2: Implement `resources.ts`**

```ts
/** Free resources the website promises. Add a row when a new lead magnet ships. */
export interface Resource { slug: string; title: string; url: string; blurb: string }
const SITE = 'https://underwings.org';
export const RESOURCES: Resource[] = [
  { slug: 'security-assessment-checklist', title: 'Security Assessment Checklist',
    url: `${SITE}/resources/underwings-security-assessment-checklist.pdf`,
    blurb: '30 items your organisation should review today — identity, endpoints, cloud, network, data, people and response.' },
];
const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');
export function resourceFor(leadMagnet: string | null | undefined): Resource | null {
  if (!leadMagnet || !leadMagnet.trim()) return null;
  const k = norm(leadMagnet);
  return RESOURCES.find((r) => r.slug === k || norm(r.title) === k) || null;
}
```
Run the test → Expected: 2 pass.

- [ ] **Step 3: The document**

Write `frontend/public/resources/underwings-security-assessment-checklist.html`: A4, dark-on-white print stylesheet, Underwings lockup (`/brand/logos/underwings-lockup-dark.png?v=3`), title, one-paragraph intro, 30 checkbox items in 7 groups (Identity & Access 5, Endpoints 4, Email & People 4, Network & Perimeter 4, Cloud & SaaS 4, Data & Backup 4, Detection & Response 5), each item one line + one "why it matters" sentence, a closing "Score yourself" box (0–10 / 11–20 / 21–30 bands) and a CTA to the free assessment with phone +971 54 707 8203 and contact@underwings.org. No prices anywhere. Render:
```bash
docker run --rm -v "$PWD/frontend/public:/work" --network host $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -m1 -i puppeteer) \
  chromium --headless --no-sandbox --disable-gpu --print-to-pdf=/work/resources/underwings-security-assessment-checklist.pdf --no-pdf-header-footer file:///work/resources/underwings-security-assessment-checklist.html
```
(If the local puppeteer image's binary is `google-chrome` or the image name differs, use the recipe in memory `feedback_screenshot_headless_verify`.) Open page 1 as PNG (`pdftoppm -png -r 60 -f 1 -l 1`) and look at it: logo visible, no clipped text, 2–3 pages. Expected size < 400 KB.

- [ ] **Step 4: Deliver it in the welcome email**

In `newsletter.ts`: `import { resourceFor } from '../../lib/resources';` and pass `resourceFor(lead_magnet)` into `sendWelcomeEmail(email, resource)` → `buildWelcomeHTML(email, resource)`. When `resource` is set: subject `Your ${resource.title} — Underwings`, and directly under the greeting a block:
```html
<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px"><tr><td style="background:#0d1f12;border:1px solid rgba(36,215,88,.2);border-radius:12px;padding:20px;text-align:center">
  <p style="margin:0 0 6px;color:#24d758;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em">Your free download</p>
  <p style="margin:0 0 14px;color:#fff;font-size:16px;font-weight:600">${resource.title}</p>
  <a href="${resource.url}" style="display:inline-block;background:#24d758;color:#051a0c!important;font-weight:700;font-size:14px;padding:12px 28px;border-radius:10px;text-decoration:none">Download the PDF</a>
</td></tr></table>
```
The team notification subject becomes `New resource download: ${resource.title} — ${email}` when a resource matched.

- [ ] **Step 5: Smoke + commit**

Add to `tests/smoke.sh`: a HEAD check that `$BASE/resources/underwings-security-assessment-checklist.pdf` returns 200 with `content-type: application/pdf` (follow the file's existing `check` helper style). Build (`docker compose build frontend`), then:
```bash
git add frontend/src/lib/resources.ts frontend/src/lib/resources.test.mjs frontend/public/resources frontend/src/pages/api/newsletter.ts tests/smoke.sh
git commit -m "feat(resources): ship the Security Assessment Checklist PDF and email it on signup

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
Execution order: run this task after Task 8 and before Task 10's deploy, so one deploy carries everything.
