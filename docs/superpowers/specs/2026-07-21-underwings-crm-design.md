# Underwings CRM — Design Spec

**Date:** 2026-07-21
**Author:** Manoj Prabhakaran (with Claude)
**Status:** Approved design — ready for implementation planning

## 1. Purpose & Context

Underwings is a 5–6 person, bootstrapped (300K AED) UAE cybersecurity **services** company (Abu Dhabi), Year-1 revenue target 400K AED (~22 engagements, ~35K AED avg, ~1.8/month). Zero paying clients at design time.

Two prior CRMs (Krayin → Frappe) and a 14-workflow n8n automation stack were built and **removed** (see [[project-crm-status]]). This spec defines a **minimal, purpose-built CRM on the existing self-hosted Supabase stack** — tuned exactly to Underwings' two sales motions, with **no speculative features**.

Founder directive: *"no extra features — tune for what Underwings needs."*

### What the CRM must fit (operating reality)
- Volumes are tiny: qualified-lead ramp target 15→30/month; ~15 active opportunities. **Hundreds of records, not thousands.** No queues, no workflow engine, no warehouse — plain Postgres tables + the existing admin SPA + SQL views.
- Single market (UAE, AED), single team, single office. WhatsApp is a first-class channel.
- Weekly Monday sales review walks every open opportunity with a committed next step — **making that meeting fast is the CRM's core job.**

## 2. Platform & Conventions (reuse as-is)

> **ARCHITECTURE REVISED 2026-07-21 (post Phase A):** The CRM is a **standalone app served AT `crm.underwings.org`** with its **own accounts/roles**, separate from the `/admin` CMS. Phase A shipped the CRM as a tab inside `/admin`; **Phase A2 (rework)** relocates it to a dedicated app and swaps the auth model. The data layer (migration 006 — tables/views/triggers) is unchanged and reused. See §12a for the rework task list.

- **Backend:** existing Supabase stack (`db`, `kong`, `auth/gotrue`, `rest/postgrest`, `realtime`, `storage`, `studio`) already in `docker-compose.yml`.
- **Schema:** migration `006_crm.sql` (data model — done) + `007_crm_roles.sql` (rework: `crm_users` table + `is_crm_user()`/`is_crm_admin()`; swap all `crm_*` RLS off `is_admin()`). Applied via `docker exec underwings-db psql`; **reload PostgREST after** (`NOTIFY pgrst, 'reload schema'`). Conventions: UUID PK `gen_random_uuid()`; `TEXT + CHECK` enums; `created_at`/`updated_at TIMESTAMPTZ DEFAULT NOW()`; `update_updated_at_column()` trigger; indexes on status/email/created_at/FKs.
- **Auth/roles (REVISED):** a **separate `crm_users` table** (`id → auth.users`, `role CHECK(admin|member)`), distinct from `admin_users`. `is_crm_user()` = membership; `is_crm_admin()` = role `admin`. RLS on every `crm_*` table: **member** = SELECT/INSERT/UPDATE `USING (is_crm_user())`; **admin** = also DELETE `USING (is_crm_admin())`. Views stay `security_invoker=true` (inherit table RLS). Service-role writes (contact form, leadgen) bypass RLS unchanged.
- **UI (REVISED):** a **new standalone `crm/` Vite SPA** (own login + **enforced TOTP MFA** shell, Chart.js, table/drawer/modal, CSV export) — the CRM module from Phase A (`admin.js` A5–A11) is ported into `crm/src/js/crm.js` nearly verbatim, gated on `is_crm_user()` after login. **Remove the CRM from `/admin`** (revert A5–A11's CMS-admin additions). CMS returns to CMS-only.
- **`crm.underwings.org` (REVISED):** nginx serves the CRM app at `/` and proxies `/{auth,rest,realtime,storage}/v1/*` → Kong, so **Supabase is same-origin** (no CORS / GoTrue-allow-list changes). The CRM app's Supabase URL = `https://crm.underwings.org`. **Public/internet-reachable** (unlike private-network `/admin`) — the gate is login + **mandatory MFA** + RLS. Existing Let's Encrypt cert reused.
- **Users (REVISED):** a new `scripts/provision-crm-user.sh` (GoTrue user + `crm_users` row). Provision **Manoj** (`admin`), **Guna / Nelson / Vinoth** (`member`). Prathima stays CMS-only (not a CRM user). Public signup disabled.

## 3. Business-Needs Analysis

### 3.1 Lead flow
**Inbound (low volume, high intent):** website contact form → Supabase; newsletter/waitlist (nurture, not deals); WhatsApp/phone/email (manual); referrals (12% partner commission); Founding-Client warm list (~45 names, 15–30% sliding discount for first 10 clients).

**Outbound (high volume, low intent):** the `leadgen/` OSINT service — up to **50 UAE companies/24h**, Claude-scored against ICP, enriched, landing in the CRM's **prospects** area (kept out of the forecast pipeline until a human promotes them).

### 3.2 Two motions
- **Services (scoped engagements):** capture → 30-min free scoping call → written proposal within 48h (30-day validity) → max one 10% discount round (Manoj approves all pricing) → sign → deposit → kickoff. Cycles 2–12 weeks. Deal sizes 9K–120K AED.
- **Software resale (Sophos, Sprinto, Hexnode, Trillium):** requirements → **24h AED quote** → PO → order → deploy (implementation + support bundled). **Annual license = renewal = the recurring-revenue book** (15% Y1 → 50% Y3 target). Deal sizes 10K–250K AED.
- **Subscriptions (PTaaS 6K/mo, Continuous Compliance 4K/mo):** **fold into Services** with `billing='monthly'` + `mrr_aed` (decision: the old standalone Subscriptions pipeline never held a deal).

### 3.3 Team roles in the CRM
- **Guna (BD)** — primary operator: outbound, partnerships, invoicing, first-line qualification.
- **Manoj** — admin; approves all pricing/discounts; owns GRC deals; default owner.
- **Nelson / Vinoth** — practitioner-owners (offensive / network+cloud+software).
- **Prathima** — marketing (newsletter/subscribers, not deals). **Gowtham** — platform.

### 3.4 What they measure (build only these)
Signed engagements/quarter (target 3) + won AED; avg deal size (35K); proposal win rate (≥40%); pipeline coverage (3× remaining quarterly target) per motion; lead-source mix trend (outbound 50%→25%, inbound 10%→35%); stale deals (30d services / 21d software); founding-client tracker (first 10); software renewal book.

## 4. Data Model — 7 tables

All tables: UUID PK, `created_at`/`updated_at` + trigger, RLS admin-only, indexes per house style.

### 4.1 `companies`
`name` (req), `domain` (unique nullable, lowercased), `website`, `industry` (free text), `emirate`, `size_band` CHECK(`sub30|sme|midmarket|enterprise`), `is_partner` bool, `notes`.
Dedupe: `lower(domain)`, fallback normalized name (mirrors leadgen's key).

### 4.2 `contacts`
`company_id` FK, `name`, `email` (unique, lowercased — **primary dedupe key**), `phone`, `whatsapp_ok` bool, `job_title`.
Newsletter/waitlist membership surfaced by an email-match **view**, not stored twice.

### 4.3 `deals`
Unified table, two motions:
- `company_id` FK, `contact_id` FK, `title`, `description`
- `motion` CHECK(`services|software`)
- `stage` — CHECK-constrained **per motion** (see §5)
- `value_aed` numeric; `billing` CHECK(`one_off|monthly`) + `mrr_aed` numeric (subscriptions)
- `offering` — services: the site's service-dropdown values + `mobile-app-pentest`; software: the 9 quote-intent categories
- `vendor` CHECK(`sophos|sprinto|hexnode|trillium|other`) — software only
- `source` — picklist (web_form, quote_intent, referral, referral_partner, whatsapp, phone, email, linkedin, cold_email, apollo, founding_outreach, leadgen, newsletter, other)
- `owner_id` FK (admin user)
- `icp_segment` CHECK(`healthcare|iso|pdpl|other`)
- `ai_score` int nullable (1–10, carried from leadgen if promoted)
- `founding_client` bool + `founding_discount_tier` CHECK(`15|20|30`)
- `status` CHECK(`open|won|lost`), `lost_reason`
- `expected_close_date`, `closed_at`, `quote_sent_at` (drives 30-day validity + follow-up)
- `proposal_url` (Supabase Storage link)
- `renewal_date` (won software — feeds renewal KPI)
- `referred_by_company_id` FK (partner attribution for 12% commission — computed manually)
- **`next_action` + `next_action_date`** (the Monday-review fields)
- `external_ref` (idempotent upserts/imports)

### 4.4 `activities`
`deal_id` FK, `type` CHECK(`note|call|email|whatsapp|meeting|stage_change|system`), `body`, `actor_id`, `occurred_at`.
A trigger **auto-logs stage changes** → free stage-history/velocity without a warehouse.

### 4.5 `suppression`
`email` unique, `reason`, `created_at`. Required for PDPL/DSAR and "never" replies. **leadgen and any future outbound must check it.** Seeded in v1.

### 4.6 `prospects` (cold OSINT — company level, separate from pipeline)
`company_name`, `domain` (dedupe), `website`, `industry`, `emirate`, `size_band`, `ai_score` (1–10, Claude ICP), `gap_score` (int, from security-signal enrichment), `talking_points` (text — auto-generated, see §6), `source`, `dedupe_key` (unique), `enrichment_status` CHECK(`new|enriching|enriched|failed`), `status` CHECK(`new|enriched|contacted|promoted|suppressed`), `promoted_deal_id` FK nullable, `notes`.

### 4.7 `prospect_contacts` (the harvested "info table" — multiple people per prospect)
`prospect_id` FK, `name`, `job_title`, `email`, `email_status` CHECK(`verified|probable|role|low|risky|invalid`), `phone`, `linkedin_url`, `source` CHECK(`scrape|hunter|pattern|search`), `confidence` int.

## 5. Pipelines — one `deals` table, two stage-sets

Enforced by CHECK: `((motion='services' AND stage IN (...)) OR (motion='software' AND stage IN (...)))`.

- **Services** (stale at **30 days** no activity):
  `new → contacted → scoping → proposal_sent → negotiation → won | lost`
  (Trims proven 9-stage Krayin set: MQL dropped — it was an AI-score gate; Discovery Booked merged into `scoping` — meeting date = `next_action_date`.)
- **Software** (stale at **21 days**):
  `new → requirements → quote_sent → po_pending → won | lost`
  (Vendor Shortlist collapses into `requirements` — outcome recorded in `vendor`; Ordered/Deployed collapse into `won` — deployment is delivery, not sales.)
- **Subscriptions:** ride Services with `billing='monthly'` + `mrr_aed`.

Staleness = SQL **view** comparing last-activity date to 30/21 days. **No cron.**

## 6. OSINT Enrichment Framework (leadgen rework — the flagship of this build)

**Decision: retire the Google Sheet.** `leadgen` writes directly into `prospects` + `prospect_contacts` in Supabase. `leadgen/lib/sheets.js` is replaced by `leadgen/lib/crm.js` (service-role writes via PostgREST/pg). Cadence: **50 companies / 24h** (`config.js` interval → 24h, cap 50).

**Tooling principle (validated by OSS-OSINT research + adversarial verification, 2026-07-21):** the entire security-signal + attack-surface layer runs at **$0** on maintained, headless, no-hidden-paid-key OSS. The one thing free tooling cannot reproduce is a *named decision-maker + verified work email at scale* (Hunter/Apollo's moat) — so plan for **~20–35% named-contact coverage** of a curated list. **À-la-carte CLIs, not a framework** (SpiderFoot is unmaintained since ~2023, does aggressive active recon, and returns no firmographics). **Passive OSINT only** — see §6.5 guardrails.

### 6.1 Per-company pipeline
1. **Discover** — existing sources (OSM / Wikidata / News, + Places / Firecrawl if keyed).
2. **Claude ICP score** (existing rubric) → `ai_score` 1–10.
3. **Deep enrich (NEW)** — write prospect + N prospect_contacts:
   - **Website scrape (multi-page):** extend existing `lib/contacts.js` paths to home / about / **team** / **leadership** / **management** / contact / **careers** → role emails, phones, staff **names + titles** (extract via Claude Haiku in `enrich.js`). This is the highest-quality *free* named-contact source. People-data = **free scrape only** (no paid people API in v1).
   - **Email harvest (tiered):** (1) role emails from scrape; (2) **native Node `dns.resolveMx`** provider classification (M365/Google/local); (3) **in-house permutation generator** (~50 lines, owned — *not* the abandoned `email-permutator` npm) for `first.last@` candidates; (4) **Hunter free-tier** (existing `lib/hunter.js`, 50 searches/100 verifies/mo) as fallback + higher-confidence verifier. Pattern guesses are tagged `probable`/`low` — **never `verified`** (SMTP RCPT is port-25-blocked/unreliable in 2026; treat as a hint, never blind-send).
   - **Firmographics:** employee-count band + industry from Wikidata/OSM; **DIFC / ADGM public registers** as optional per-lead named-director lookup (only free UAE source exposing officers — bullseye for the finance/regulated ICP).
4. **Suppression check** — drop/flag anyone on the `suppression` list before surfacing.
5. **Persist** — upsert by `dedupe_key`; tolerant of re-runs (idempotent).

### 6.2 Security-signal enrichment → auto `talking_points` + `gap_score` (free OSINT)
This is what makes enrichment worth more to a *cybersecurity* seller than generic contact-finding. All free, all feeding a per-company sales hook. Named tools are MIT Go binaries baked into the leadgen image (see §6.4) or native Node:
- **Attack surface:** **subfinder** (passive; consumes crt.sh *internally* — no direct hammering of crt.sh's 5-req/min endpoint) → **dnsx** (resolve) → **httpx** (live hosts). Subdomain count = visible attack surface → pentest hook.
- **Tech fingerprint:** **`httpx -tech-detect`** (embedded `wappalyzergo`, free — no WhatWeb/Ruby needed) → outdated stack = VA/pentest hook.
- **TLS/cert posture:** **`httpx -tls-grab`** baseline; optional deep **`testssl.sh --fast`** (Docker sidecar) → expired/legacy-TLS/no-HSTS talking points.
- **DNS / MX / SPF / DMARC:** **native Node `dns`** (`resolveMx` + `_dmarc` TXT lookup). Email provider = upsell angle; **missing DMARC = concrete finding** to open cold outreach.
- **Careers page signals:** hiring + whether they have security staff (no CISO/security roles = ICP fit).
- **Breach signal:** **XposedOrNot** keyless **email-level** lookup ($0 primary); **HIBP Core 1** ($4.39/mo) optional-if-keyed via `HIBP_API_KEY`. NOTE: HIBP/XposedOrNot *domain* search is owner-gated (only works on your own domain) — use **email-level** lookups for prospects, and cite only the **aggregate** ("appears in N public breaches"), never a raw credential.
- **Typosquat/lookalike (premium, high-value leads only):** **dnstwist** (Docker sidecar) → "N registered lookalikes of yourbank.ae with live MX" — strong for banks/gov.
- **UAE-specific:** Abu Dhabi DoH health-license → mandatory **ADHICS v2** trigger (best cold segment). Per-facility manual/form lookup, **no bulk API** — treat as a curated seed list, not an automated source.

Each signal contributes to `gap_score` and appends a line to `talking_points`. Outreach (manual in v1) uses these directly.

### 6.3 Budget guard
Free sources **always**. Paid-if-keyed (Hunter beyond free tier, HIBP) only when free fails, under a cap. NOTE: `lib/budget.js` is **monthly**-keyed today — add a **daily** `dayKey` (`YYYY-MM-DD`) variant/second counter for the §6.3 daily cap. New `config.js` keys:
- `security: { subfinder: true, dnsx: true, httpx: true, testssl: false, dnstwist: false, binPath: '/usr/local/bin', timeoutMs: 60000 }`
- `breach: { provider: 'xposedornot', hibpDailyCap: 40 }` (optional `HIBP_API_KEY`)
- `emailVerify: { smtpProbe: false, patternGuess: true, patterns: ['first.last','flast','first','f.last','firstl'] }`
- `people: { teamPageScrape: true, difcAdgm: false, linkedinDork: false }`
- Optional env: `HIBP_API_KEY`, `SEARXNG_URL` (only if LinkedIn dorking ever enabled).

### 6.4 Docker / runtime
Preserve the zero-runtime-dependency ethos: add only three static MIT Go binaries via multi-stage build (~+40–60 MB, **no Python**):
```dockerfile
FROM golang:1.23 AS osint
RUN GOBIN=/out go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest \
 && GOBIN=/out go install github.com/projectdiscovery/dnsx/cmd/dnsx@latest \
 && GOBIN=/out go install github.com/projectdiscovery/httpx/cmd/httpx@latest
FROM node:20-slim
COPY --from=osint /out/* /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
```
Invoke via `child_process` with `-json`/JSONL + timeouts. `checkdmarc` / `testssl.sh` / `dnstwist` stay **optional sidecar containers** (official images, `docker run`), never baked in. crt.sh (inside subfinder), XposedOrNot, HIBP and the permutator reuse `lib/http.js` — zero new bytes.

### 6.5 Legal / ethical guardrails (hard constraints)
- **Passive OSINT only.** **NO active port scanning** (naabu/nmap) or active DNS brute-force against cold prospects — UAE **Federal Decree-Law 34/2021** criminalizes unauthorized/attempted access (AED 100k–500k + up to 5 yrs). Gate any active recon behind a signed engagement.
- **NO M365 tenant enumeration** (o365enum/o365spray) — stale, datacenter-throttled, PDPL-grey.
- **Breach data:** cite only aggregate metadata; **never possess/parse/quote raw credential dumps** (no h8mail-on-dumps, Dehashed plaintext) — no PDPL lawful basis.
- **LinkedIn-via-search:** default **OFF** (LinkedIn UA breach + Google SERP ToS + PDPL). If ever enabled: public profile URL + name/title only, throttled, suppression-honored, never behind auth.
- **PDPL (Decree-Law 45/2021):** no B2B carve-out — legitimate-interest basis is defensible at 50/day; enforce the `suppression` table before surfacing any contact, provide easy opt-out, prefer passive DNS/MX signals over mailbox probing.
- **Tools explicitly rejected** (research-backed): theHarvester (low named-yield, adds Python), holehe/Infoga/mosint (abandoned/paid-key wrappers), naabu (free mode wraps Shodan InternetDB = not commercial-licensed; active scan = legal exposure), o365enum, SpiderFoot-as-core, assetfinder/Sublist3r/findomain (unmaintained; subfinder is strictly better), h8mail/breach-parse/Dehashed.

### 6.4 Prospect → pipeline promotion
Prospects are **not** deals. In `/admin/crm`, a prospect list (searchable, suppression-aware) has a **"Promote to deal"** action → creates `company` + `contact` + `deal` (stage `new`, `source='leadgen'`, carries `ai_score`), sets `prospects.status='promoted'` + `promoted_deal_id`. When a real person replies/contacts, the same record moves `new → contacted` on promotion. This keeps 350 cold rows/week out of the forecast while making them one click from becoming pipeline.

## 7. Integrations

1. **Contact form (must-fix):** repair `frontend/src/pages/api/contact.ts` field mapping (user message currently dropped; `service_interest` always null) and parse `?intent=quote-*` on the form JS. Then `contact.ts` writes CRM rows directly with its existing service-role client: upsert contact (by email) + company (by domain/name) → create deal (`intent=quote-*` or service dropdown `security-software` ⇒ `motion='software'`, else `services`) → activity note. Keep the `form_submissions` insert as raw archive. Retire the dead `notifyN8nInbound` / `NEWSLETTER_WEBHOOK_URL` paths.
2. **Newsletter / waitlist:** no deals. Keep `subscribers` / `waitlist_signups`; surface as a badge on the contact drawer via an email-match view.
3. **Email (Stalwart):** in-network SMTP (`stalwart:587`) for a new-deal notification to the owner — reuse existing send code. No inbox sync/BCC. Calls/emails logged manually as activities.
4. **Cal.com — DROPPED:** remove `book.underwings.org` links from the site; meetings tracked via `next_action_date` + a `meeting` activity.
5. **WhatsApp:** `wa.me` click-to-chat link on the contact; manual activity logging. No API.

## 8. Reporting — SQL views + existing Chart.js cards (no warehouse)

`v_pipeline` (count+AED by motion/stage), `v_quarter_scoreboard` (won count/value vs 3-per-quarter + 35K avg + win rate), `v_source_mix`, `v_stale_deals`, `v_renewals_next_90d`, `v_founding_tracker` (first-10 slots by discount tier).

## 9. Explicitly EXCLUDED (YAGNI)

AI scoring *inside* the CRM (leadgen already scores; inbound ~1–2/day, humans triage faster) · proposal generator / e-sign / pre-call AI briefs (proposals are PDFs in Storage + a link field) · warehouse / ETL / Metabase / velocity marts (SQL views suffice) · outbound sequencer / approval queue / send caps / reply-sentiment (outbound manual until well past first clients) · Slack notification fabric (one owner email; 5 people sit together) · stage probabilities / weighted forecasting (meaningless at n<20) · EAV / custom-field engine (fixed columns; new field = 5-line migration) · CPQ / line-items / discount-approval workflow (floor prices + Manoj approval = a process, not software) · lead-vs-deal entity split · duplicate-merge UI · multi-currency · territories · email-marketing module · mobile app · chat-widget lead capture · Plane/delivery auto-creation on Won · automated PDPL retention cron (keep policy; run documented purge SQL manually each quarter) · paid people-data API (Apollo/Proxycurl) and LinkedIn scraping — free scrape only in v1 (accept ~20–35% named-contact coverage) · OSINT framework (SpiderFoot/recon-ng/Maltego) — à-la-carte CLIs instead · active port scanning (naabu/nmap) and M365 tenant enumeration (o365enum) — legally/ToS out of bounds for cold prospects.

## 10. Data & Migration Defaults

- **Start empty.** Hand-enter the ~45 warm founding-outreach targets + any active conversations. **Seed only the suppression list** (from the old `uw_outbound_suppression` table if recoverable). No Krayin/Frappe bulk import.
- PDPL retention policy retained (inbound anonymised at 24 months inactive, pure outbound at 12, Won clients kept 7 years) — enforced by **manual quarterly purge SQL**, not a cron, at this volume.

## 11. Open Items / Risks

- **leadgen write path:** decide pg-direct vs PostgREST-with-service-role from inside the `leadgen` container (both on `underwings-network`). PostgREST + service-role keeps one access pattern; pg-direct is simpler for batch upserts. Resolve in the implementation plan.
- **Breach lookup (resolved 2026-07-21):** use **XposedOrNot keyless email-level** lookup as the $0 default; **HIBP Core 1 ($4.39/mo)** optional-if-keyed for cleaner data. Domain-wide search is owner-gated (own domain only) — prospects use email-level lookups, citing aggregate only.
- **verifyAdmin() gap** must be fixed before any CRM write endpoint is reachable outside the private-IP allowlist.

## 12. Build Order (for the implementation plan)

1. `006_crm.sql` — 7 tables + views + triggers + RLS; provision Guna/Prathima; seed suppression.
2. `/admin/crm` module — deals board (two stage-sets), company/contact drawers, activity timeline, prospects list + Promote-to-deal, reporting cards. `crm.underwings.org` redirect.
3. Contact-form fix + direct CRM writes from `api/contact.ts`; newsletter email-match view; retire dead webhook paths.
4. leadgen rework — `crm.js` sink replacing `sheets.js`; multi-stage Dockerfile adds subfinder/dnsx/httpx (§6.4); deep-enrich module (team-page scrape + Haiku name/title, in-house email permutator, native-Node DNS/MX/DMARC, subfinder→dnsx→httpx attack-surface + tech + TLS, XposedOrNot breach → talking_points/gap_score); daily budget guard; suppression check; 24h/50 cadence.
5. Owner-email notification via Stalwart; remove Cal.com/book.underwings.org links; WhatsApp click-to-chat.
