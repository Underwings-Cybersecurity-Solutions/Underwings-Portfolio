# Underwings CRM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal, purpose-built CRM for Underwings on the existing self-hosted Supabase stack — two sales pipelines (services + software resale), a cold-prospect OSINT layer fed by the leadgen service, and direct website-lead capture — with zero new infrastructure.

**Architecture:** One idempotent SQL migration adds seven `crm_*` tables + reporting views to the existing Postgres. A new CRM module is added to the existing vanilla-JS admin SPA (`/admin/`), modelled exactly on its current Leads module. The website contact form is fixed and writes CRM rows directly via the frontend's existing service-role Supabase client. The `leadgen` Node service swaps its Google-Sheets sink for direct Supabase writes and gains a $0 OSINT enrichment layer (native-Node DNS + three MIT Go binaries + free breach API).

**Tech Stack:** PostgreSQL 15 (Supabase), vanilla JS + Vite 5 + `@supabase/supabase-js` + Chart.js (admin), Astro API routes + service-role `@supabase/supabase-js` (frontend), zero-dependency Node ≥20 (leadgen) with `node:test` for unit tests, three ProjectDiscovery Go binaries (subfinder/dnsx/httpx).

## Global Constraints

- **DB conventions (match `supabase/migrations/005_leads_module.sql` exactly):** UUID PK `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`; enums as `TEXT ... CHECK (col IN (...))`; `created_at`/`updated_at TIMESTAMPTZ DEFAULT NOW()`; every table `ENABLE ROW LEVEL SECURITY` then `DROP POLICY IF EXISTS "<name>" ...; CREATE POLICY "Admins can manage <x>" ... FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());`; indexes `CREATE INDEX IF NOT EXISTS idx_<table>_<col> ...`, time columns `DESC`, case-insensitive unique via `CREATE UNIQUE INDEX ... (lower(col))`.
- **Idempotent migrations only** — no rollback files. Use `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP POLICY/TRIGGER IF EXISTS` before every `CREATE`, `CREATE OR REPLACE FUNCTION`, `ON CONFLICT` for seeds. Must be safe to run twice.
- **Apply migrations with:** `cat supabase/migrations/006_crm.sql | docker exec -i underwings-db psql -U postgres -d underwings` (DB user `postgres`, DB name `underwings`).
- **Do NOT redefine** `public.update_updated_at_column()` or `public.is_admin()` — they already exist (init.sql + migration 002). Just use them.
- **FK convention:** owner/actor columns → `REFERENCES public.admin_users(id)` (an admin's id, which is itself `auth.users(id)`).
- **Table naming:** all CRM tables are prefixed `crm_` (e.g. `crm_deals`) to bound the module and avoid collisions; the spec's unprefixed names map 1:1.
- **Admin SPA:** vanilla JS only (no framework); data access via `supabase.from(...)` with the anon key + authenticated JWT (RLS enforces admin-only). Follow the Leads-module patterns in `admin/src/js/admin.js` lines 1959–2218.
- **leadgen:** keep **zero runtime npm dependencies** — built-in `fetch`/`crypto`/`node:test`/`child_process` only. Node ≥20.
- **$0 stack / passive-OSINT only:** no paid API is required to run; Hunter + HIBP are optional-if-keyed. **No active port scanning, no M365 tenant enumeration, no LinkedIn scraping** (spec §6.5).
- **Money is AED**, single market, tiny volume (hundreds of rows). No queues, no warehouse, no cron — SQL views compute staleness/reporting on read.
- **Currency/copy:** all monetary UI labelled `AED`.

---

## Phase A — CRM foundation (ships: a working deal board you can run your Monday review on)

### Task A1: Migration file — the seven CRM tables

**Files:**
- Create: `supabase/migrations/006_crm.sql`

**Interfaces:**
- Produces: tables `crm_companies`, `crm_contacts`, `crm_deals`, `crm_activities`, `crm_suppression`, `crm_prospects`, `crm_prospect_contacts`; trigger functions `crm_sync_deal_status()`, `crm_log_stage_change()`. Later tasks (admin UI, leadgen, contact form) read/write these exact column names.

- [ ] **Step 1: Write the tables section of the migration**

Create `supabase/migrations/006_crm.sql` with this content (Part 1 of 3 — Tasks A1/A2 append Parts 2/3 to the same file):

```sql
-- ===========================================
-- MIGRATION 006: Custom CRM module
--   7 tables (crm_companies/contacts/deals/activities/suppression/
--   prospects/prospect_contacts) + status/stage triggers + views + seed.
--   Idempotent; safe to re-run. Uses existing update_updated_at_column()
--   and is_admin() (do NOT redefine them here).
-- ===========================================

-- ---------- 1. crm_companies ----------
CREATE TABLE IF NOT EXISTS public.crm_companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    domain TEXT,                       -- lowercased; unique via index below
    website TEXT,
    industry TEXT,
    emirate TEXT,
    size_band TEXT CHECK (size_band IN ('sub30','sme','midmarket','enterprise')),
    is_partner BOOLEAN DEFAULT false,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_companies_domain ON public.crm_companies(lower(domain)) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_companies_name    ON public.crm_companies(lower(name));
CREATE INDEX IF NOT EXISTS idx_crm_companies_created ON public.crm_companies(created_at DESC);
ALTER TABLE public.crm_companies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can manage crm companies" ON public.crm_companies;
CREATE POLICY "Admins can manage crm companies" ON public.crm_companies
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP TRIGGER IF EXISTS update_crm_companies_updated_at ON public.crm_companies;
CREATE TRIGGER update_crm_companies_updated_at BEFORE UPDATE ON public.crm_companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- 2. crm_contacts ----------
CREATE TABLE IF NOT EXISTS public.crm_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES public.crm_companies(id) ON DELETE SET NULL,
    name TEXT,
    email TEXT,                        -- lowercased; primary dedupe key (unique index)
    phone TEXT,
    whatsapp_ok BOOLEAN DEFAULT false,
    job_title TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_contacts_email ON public.crm_contacts(lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_company ON public.crm_contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_created ON public.crm_contacts(created_at DESC);
ALTER TABLE public.crm_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can manage crm contacts" ON public.crm_contacts;
CREATE POLICY "Admins can manage crm contacts" ON public.crm_contacts
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP TRIGGER IF EXISTS update_crm_contacts_updated_at ON public.crm_contacts;
CREATE TRIGGER update_crm_contacts_updated_at BEFORE UPDATE ON public.crm_contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- 3. crm_deals ----------
CREATE TABLE IF NOT EXISTS public.crm_deals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES public.crm_companies(id) ON DELETE SET NULL,
    contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    motion TEXT NOT NULL CHECK (motion IN ('services','software')),
    stage TEXT NOT NULL DEFAULT 'new',
    value_aed NUMERIC,
    billing TEXT DEFAULT 'one_off' CHECK (billing IN ('one_off','monthly')),
    mrr_aed NUMERIC,
    offering TEXT,                     -- service dropdown value OR software quote-intent category
    vendor TEXT CHECK (vendor IN ('sophos','sprinto','hexnode','trillium','other')),
    source TEXT DEFAULT 'other' CHECK (source IN (
        'web_form','quote_intent','referral','referral_partner','whatsapp',
        'phone','email','linkedin','cold_email','apollo','founding_outreach',
        'leadgen','newsletter','other')),
    owner_id UUID REFERENCES public.admin_users(id),
    icp_segment TEXT CHECK (icp_segment IN ('healthcare','iso','pdpl','other')),
    ai_score INT,
    founding_client BOOLEAN DEFAULT false,
    founding_discount_tier TEXT CHECK (founding_discount_tier IN ('15','20','30')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
    lost_reason TEXT,
    expected_close_date DATE,
    closed_at TIMESTAMPTZ,
    quote_sent_at TIMESTAMPTZ,
    proposal_url TEXT,
    renewal_date DATE,
    referred_by_company_id UUID REFERENCES public.crm_companies(id) ON DELETE SET NULL,
    next_action TEXT,
    next_action_date DATE,
    external_ref TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT crm_deals_stage_valid CHECK (
        (motion = 'services' AND stage IN ('new','contacted','scoping','proposal_sent','negotiation','won','lost'))
     OR (motion = 'software' AND stage IN ('new','requirements','quote_sent','po_pending','won','lost'))
    )
);
CREATE INDEX IF NOT EXISTS idx_crm_deals_motion_stage ON public.crm_deals(motion, stage);
CREATE INDEX IF NOT EXISTS idx_crm_deals_status  ON public.crm_deals(status);
CREATE INDEX IF NOT EXISTS idx_crm_deals_owner   ON public.crm_deals(owner_id);
CREATE INDEX IF NOT EXISTS idx_crm_deals_company ON public.crm_deals(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_deals_next    ON public.crm_deals(next_action_date);
CREATE INDEX IF NOT EXISTS idx_crm_deals_renewal ON public.crm_deals(renewal_date);
CREATE INDEX IF NOT EXISTS idx_crm_deals_created ON public.crm_deals(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_deals_external_ref ON public.crm_deals(external_ref) WHERE external_ref IS NOT NULL;
ALTER TABLE public.crm_deals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can manage crm deals" ON public.crm_deals;
CREATE POLICY "Admins can manage crm deals" ON public.crm_deals
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP TRIGGER IF EXISTS update_crm_deals_updated_at ON public.crm_deals;
CREATE TRIGGER update_crm_deals_updated_at BEFORE UPDATE ON public.crm_deals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- 4. crm_activities ----------
CREATE TABLE IF NOT EXISTS public.crm_activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID REFERENCES public.crm_deals(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('note','call','email','whatsapp','meeting','stage_change','system')),
    body TEXT,
    actor_id UUID REFERENCES public.admin_users(id),
    occurred_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_activities_deal ON public.crm_activities(deal_id, occurred_at DESC);
ALTER TABLE public.crm_activities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can manage crm activities" ON public.crm_activities;
CREATE POLICY "Admins can manage crm activities" ON public.crm_activities
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ---------- 5. crm_suppression ----------
CREATE TABLE IF NOT EXISTS public.crm_suppression (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_suppression_email ON public.crm_suppression(lower(email));
ALTER TABLE public.crm_suppression ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can manage crm suppression" ON public.crm_suppression;
CREATE POLICY "Admins can manage crm suppression" ON public.crm_suppression
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ---------- 6. crm_prospects (cold OSINT, company-level) ----------
CREATE TABLE IF NOT EXISTS public.crm_prospects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name TEXT NOT NULL,
    domain TEXT,
    website TEXT,
    industry TEXT,
    emirate TEXT,
    size_band TEXT CHECK (size_band IN ('sub30','sme','midmarket','enterprise')),
    ai_score INT,
    gap_score INT,
    talking_points TEXT,
    source TEXT,
    dedupe_key TEXT NOT NULL,
    enrichment_status TEXT NOT NULL DEFAULT 'new' CHECK (enrichment_status IN ('new','enriching','enriched','failed')),
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','enriched','contacted','promoted','suppressed')),
    promoted_deal_id UUID REFERENCES public.crm_deals(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_prospects_dedupe ON public.crm_prospects(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_crm_prospects_status ON public.crm_prospects(status);
CREATE INDEX IF NOT EXISTS idx_crm_prospects_score  ON public.crm_prospects(ai_score DESC);
CREATE INDEX IF NOT EXISTS idx_crm_prospects_created ON public.crm_prospects(created_at DESC);
ALTER TABLE public.crm_prospects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can manage crm prospects" ON public.crm_prospects;
CREATE POLICY "Admins can manage crm prospects" ON public.crm_prospects
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP TRIGGER IF EXISTS update_crm_prospects_updated_at ON public.crm_prospects;
CREATE TRIGGER update_crm_prospects_updated_at BEFORE UPDATE ON public.crm_prospects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------- 7. crm_prospect_contacts (people found per prospect) ----------
CREATE TABLE IF NOT EXISTS public.crm_prospect_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id UUID REFERENCES public.crm_prospects(id) ON DELETE CASCADE,
    name TEXT,
    job_title TEXT,
    email TEXT,
    email_status TEXT CHECK (email_status IN ('verified','probable','role','low','risky','invalid')),
    phone TEXT,
    linkedin_url TEXT,
    source TEXT CHECK (source IN ('scrape','hunter','pattern','search')),
    confidence INT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_prospect_contacts_prospect ON public.crm_prospect_contacts(prospect_id);
CREATE INDEX IF NOT EXISTS idx_crm_prospect_contacts_email ON public.crm_prospect_contacts(lower(email));
ALTER TABLE public.crm_prospect_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can manage crm prospect contacts" ON public.crm_prospect_contacts;
CREATE POLICY "Admins can manage crm prospect contacts" ON public.crm_prospect_contacts
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());
```

- [ ] **Step 2: Append the two deal triggers to the same file**

Append to `supabase/migrations/006_crm.sql`:

```sql
-- ---------- deal status auto-sync from stage ----------
CREATE OR REPLACE FUNCTION public.crm_sync_deal_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.stage = 'won' THEN
        NEW.status := 'won';
        IF NEW.closed_at IS NULL THEN NEW.closed_at := NOW(); END IF;
    ELSIF NEW.stage = 'lost' THEN
        NEW.status := 'lost';
        IF NEW.closed_at IS NULL THEN NEW.closed_at := NOW(); END IF;
    ELSE
        NEW.status := 'open';
        NEW.closed_at := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS crm_deals_sync_status ON public.crm_deals;
CREATE TRIGGER crm_deals_sync_status BEFORE INSERT OR UPDATE ON public.crm_deals
    FOR EACH ROW EXECUTE FUNCTION public.crm_sync_deal_status();

-- ---------- auto-log stage changes as activities ----------
CREATE OR REPLACE FUNCTION public.crm_log_stage_change()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.crm_activities (deal_id, type, body, actor_id, occurred_at)
    VALUES (NEW.id, 'stage_change',
            format('Stage: %s → %s', OLD.stage, NEW.stage),
            auth.uid(), NOW());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS crm_deals_log_stage ON public.crm_deals;
CREATE TRIGGER crm_deals_log_stage AFTER UPDATE ON public.crm_deals
    FOR EACH ROW WHEN (OLD.stage IS DISTINCT FROM NEW.stage)
    EXECUTE FUNCTION public.crm_log_stage_change();
```

- [ ] **Step 3: Verify the SQL parses without applying to the live DB**

Run: `docker run --rm -i postgres:15 psql --set ON_ERROR_STOP=1 -h /nonexistent 2>/dev/null; echo "syntax-only check skipped"` — then do the real check by applying inside a throwaway transaction:

Run:
```bash
{ echo "BEGIN;"; cat supabase/migrations/006_crm.sql; echo "ROLLBACK;"; } | docker exec -i underwings-db psql -U postgres -d underwings -v ON_ERROR_STOP=1
```
Expected: no error output; ends with `ROLLBACK`. Any `ERROR:` line means fix the SQL before proceeding. (This validates against the real Postgres 15 without persisting.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/006_crm.sql
git commit -m "feat(crm): migration 006 — 7 CRM tables + deal status/stage triggers"
```

---

### Task A2: Migration — reporting & signal views + suppression seed

**Files:**
- Modify: `supabase/migrations/006_crm.sql` (append Part 3)

**Interfaces:**
- Consumes: all `crm_*` tables from A1; existing `subscribers`, `waitlist_signups` tables.
- Produces: views `v_crm_pipeline`, `v_crm_quarter_scoreboard`, `v_crm_source_mix`, `v_crm_stale_deals`, `v_crm_renewals_next_90d`, `v_crm_founding_tracker`, `v_crm_contact_signals`. Admin reporting cards (A10) and contact drawer badge (A7) read these.

- [ ] **Step 1: Append the views to `006_crm.sql`**

All views use `security_invoker=true` so admin RLS applies (PG15 feature; prevents the view owner bypassing RLS):

```sql
-- ---------- reporting views (security_invoker => caller RLS applies) ----------
CREATE OR REPLACE VIEW public.v_crm_pipeline
    WITH (security_invoker=true) AS
SELECT motion, stage,
       count(*)                         AS deal_count,
       COALESCE(sum(value_aed), 0)      AS value_aed
FROM public.crm_deals
WHERE status = 'open'
GROUP BY motion, stage;

CREATE OR REPLACE VIEW public.v_crm_quarter_scoreboard
    WITH (security_invoker=true) AS
WITH q AS (SELECT date_trunc('quarter', NOW()) AS qstart)
SELECT
    count(*) FILTER (WHERE status = 'won')                              AS won_count,
    COALESCE(sum(value_aed) FILTER (WHERE status = 'won'), 0)           AS won_value_aed,
    count(*) FILTER (WHERE status = 'lost')                             AS lost_count,
    ROUND(count(*) FILTER (WHERE status = 'won')::numeric
          / NULLIF(count(*) FILTER (WHERE status IN ('won','lost')), 0) * 100, 1) AS win_rate_pct,
    ROUND(AVG(value_aed) FILTER (WHERE status = 'won'), 0)              AS avg_won_aed
FROM public.crm_deals, q
WHERE closed_at >= q.qstart;

CREATE OR REPLACE VIEW public.v_crm_source_mix
    WITH (security_invoker=true) AS
SELECT source,
       count(*)                                  AS deal_count,
       count(*) FILTER (WHERE status = 'won')     AS won_count
FROM public.crm_deals
GROUP BY source;

CREATE OR REPLACE VIEW public.v_crm_stale_deals
    WITH (security_invoker=true) AS
SELECT d.*,
       COALESCE(la.last_activity, d.updated_at) AS last_activity,
       CASE WHEN d.motion = 'services' THEN 30 ELSE 21 END AS stale_after_days
FROM public.crm_deals d
LEFT JOIN (
    SELECT deal_id, max(occurred_at) AS last_activity
    FROM public.crm_activities GROUP BY deal_id
) la ON la.deal_id = d.id
WHERE d.status = 'open'
  AND COALESCE(la.last_activity, d.updated_at) <
      NOW() - (CASE WHEN d.motion = 'services' THEN INTERVAL '30 days' ELSE INTERVAL '21 days' END);

CREATE OR REPLACE VIEW public.v_crm_renewals_next_90d
    WITH (security_invoker=true) AS
SELECT id, title, company_id, value_aed, renewal_date, owner_id
FROM public.crm_deals
WHERE status = 'won' AND motion = 'software'
  AND renewal_date IS NOT NULL
  AND renewal_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days';

CREATE OR REPLACE VIEW public.v_crm_founding_tracker
    WITH (security_invoker=true) AS
SELECT id, title, company_id, founding_discount_tier, status, value_aed, closed_at
FROM public.crm_deals
WHERE founding_client = true
ORDER BY closed_at NULLS LAST;

CREATE OR REPLACE VIEW public.v_crm_contact_signals
    WITH (security_invoker=true) AS
SELECT c.id AS contact_id, c.email,
       EXISTS (SELECT 1 FROM public.subscribers s
               WHERE lower(s.email) = lower(c.email) AND s.subscribed) AS is_subscriber,
       EXISTS (SELECT 1 FROM public.waitlist_signups w
               WHERE lower(w.email) = lower(c.email))                  AS on_waitlist
FROM public.crm_contacts c
WHERE c.email IS NOT NULL;
```

- [ ] **Step 2: Append a guarded suppression seed (safe no-op if the old table is gone)**

```sql
-- ---------- seed suppression from legacy table if it still exists ----------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = 'uw_outbound_suppression') THEN
        INSERT INTO public.crm_suppression (email, reason)
        SELECT lower(email), 'migrated from uw_outbound_suppression'
        FROM public.uw_outbound_suppression
        WHERE email IS NOT NULL
        ON CONFLICT (lower(email)) DO NOTHING;
    END IF;
END $$;
```

- [ ] **Step 3: Re-validate the whole file in a rolled-back transaction**

Run:
```bash
{ echo "BEGIN;"; cat supabase/migrations/006_crm.sql; echo "ROLLBACK;"; } | docker exec -i underwings-db psql -U postgres -d underwings -v ON_ERROR_STOP=1
```
Expected: no `ERROR:` lines, ends `ROLLBACK`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/006_crm.sql
git commit -m "feat(crm): reporting/signal views + guarded suppression seed"
```

---

### Task A3: Apply the migration + provision Guna & Prathima + verify RLS

**Files:**
- Read: `scripts/provision-admin.sh`
- Modify: `/home/deployer/underwings/.env` (temporarily, for provisioning — do not commit secrets)

- [ ] **Step 1: Apply the migration for real**

Run:
```bash
cat supabase/migrations/006_crm.sql | docker exec -i underwings-db psql -U postgres -d underwings -v ON_ERROR_STOP=1
```
Expected: a series of `CREATE TABLE` / `CREATE INDEX` / `CREATE POLICY` / `CREATE FUNCTION` / `CREATE TRIGGER` / `CREATE VIEW` / `DO` notices, no `ERROR:`.

- [ ] **Step 2: Verify all 7 tables + 7 views exist**

Run:
```bash
docker exec -i underwings-db psql -U postgres -d underwings -c "\dt public.crm_*" -c "\dv public.v_crm_*"
```
Expected: 7 tables (`crm_activities, crm_companies, crm_contacts, crm_deals, crm_prospect_contacts, crm_prospects, crm_suppression`) and 7 views listed.

- [ ] **Step 3: Verify the stage CHECK + status trigger with a throwaway insert**

Run:
```bash
docker exec -i underwings-db psql -U postgres -d underwings -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
-- invalid stage for motion must fail:
SAVEPOINT s1;
DO $$ BEGIN
  INSERT INTO public.crm_deals (title, motion, stage) VALUES ('bad', 'software', 'scoping');
  RAISE EXCEPTION 'CHECK did not fire';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK: stage CHECK works'; END $$;
ROLLBACK TO SAVEPOINT s1;
-- won stage must set status=won + closed_at:
INSERT INTO public.crm_deals (title, motion, stage) VALUES ('t', 'services', 'won');
SELECT status, (closed_at IS NOT NULL) AS closed_set FROM public.crm_deals WHERE title='t';
ROLLBACK;
SQL
```
Expected: `NOTICE: OK: stage CHECK works`, then a row `won | t` (status=won, closed_set=t).

- [ ] **Step 4: Provision Guna and Prathima as admins**

Read `scripts/provision-admin.sh` (it reads `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`SERVICE_ROLE_KEY` from `.env`, creates the GoTrue user, upserts `admin_users`). Run it once per person by temporarily setting the two vars. Replace the emails/passwords with the real ones Manoj provides:

```bash
# Guna
ADMIN_EMAIL="guna@underwings.org" ADMIN_PASSWORD="<set-strong-temp>" bash scripts/provision-admin.sh
# Prathima
ADMIN_EMAIL="prathima@underwings.org" ADMIN_PASSWORD="<set-strong-temp>" bash scripts/provision-admin.sh
```
Expected: script prints success for each; each user id upserted into `admin_users`.

- [ ] **Step 5: Verify both are admins**

Run:
```bash
docker exec -i underwings-db psql -U postgres -d underwings -c \
"SELECT u.email, a.role FROM public.admin_users a JOIN auth.users u ON u.id=a.id ORDER BY u.email;"
```
Expected: rows for guna@ and prathima@ with role `admin` (plus existing admins).

- [ ] **Step 6: Commit (no secrets)**

Nothing to commit for provisioning (it mutates the DB, not the repo). If you added the two emails to any tracked docs, commit only that. Otherwise skip.

---

### Task A4: nginx — point `crm.underwings.org` at `/admin/crm`

**Files:**
- Modify: `nginx/nginx.conf`

**Interfaces:**
- Produces: `https://crm.underwings.org` 301-redirects to the main site's `/admin/` (team-notification emails hardcode `crm.underwings.org/admin`).

- [ ] **Step 1: Add a redirect server block for crm.underwings.org**

The old CRM server blocks were removed earlier. Add near the other server blocks in `nginx/nginx.conf` (there is still a valid Let's Encrypt cert at `/etc/letsencrypt/live/crm.underwings.org/`):

```nginx
    # ===========================================
    # crm.underwings.org — redirect to the built-in admin CRM
    # ===========================================
    server {
        listen 80;
        server_name crm.underwings.org;
        location /.well-known/acme-challenge/ { root /var/www/certbot; }
        location / { return 301 https://underwings.org/admin/; }
    }
    server {
        listen 443 ssl;
        http2 on;
        server_name crm.underwings.org;
        ssl_certificate     /etc/letsencrypt/live/crm.underwings.org/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/crm.underwings.org/privkey.pem;
        ssl_protocols       TLSv1.2 TLSv1.3;
        location / { return 301 https://underwings.org/admin/; }
    }
```

- [ ] **Step 2: Validate + reload nginx**

Run:
```bash
docker compose build nginx && docker compose up -d nginx
docker compose exec -T nginx nginx -t
```
Expected: `configuration file /etc/nginx/nginx.conf test is successful`, container healthy.

- [ ] **Step 3: Verify the redirect**

Run:
```bash
docker compose exec -T nginx sh -c "wget -O /dev/null -S --header='Host: crm.underwings.org' http://127.0.0.1/ 2>&1 | grep -i 'HTTP/\|Location' | head -3"
```
Expected: `301 Moved Permanently` → `Location: https://underwings.org/admin/`.

- [ ] **Step 4: Commit**

```bash
git add nginx/nginx.conf
git commit -m "feat(crm): redirect crm.underwings.org to /admin CRM"
```

---

### Task A5: Admin SPA — CRM page shell, sidebar entry, nav route

**Files:**
- Modify: `admin/src/index.html` (sidebar nav ~line 116; add a `#page-crm` block)
- Modify: `admin/src/js/admin.js` (`navigateTo` switch, lines 396–448)
- Modify: `admin/src/css/admin.css` (append CRM styles)

**Interfaces:**
- Produces: a `crm` page that `navigateTo('crm')` shows and calls `loadCrm()`. Later A6–A11 fill `loadCrm()` and the page markup.

- [ ] **Step 1: Add the sidebar link**

In `admin/src/index.html`, immediately after the existing Leads nav item (~line 116), add:
```html
        <a href="#" class="nav-item" data-page="crm">
          <span class="nav-icon">📊</span> CRM
        </a>
```
(Match the exact `class`/structure of the adjacent `data-page="leads"` anchor — copy its markup and change `data-page` + label.)

- [ ] **Step 2: Add the page container**

In `admin/src/index.html`, after the existing `#page-leads` `<div class="page">…</div>` block, add an empty shell (A6–A10 fill it):
```html
      <div id="page-crm" class="page">
        <div class="page-header">
          <h1>CRM</h1>
          <div class="crm-actions">
            <button id="crm-new-deal-btn" class="btn btn-primary">+ New Deal</button>
            <button id="crm-export-btn" class="btn">Export CSV</button>
          </div>
        </div>
        <div id="crm-scoreboard" class="crm-scoreboard"></div>
        <div class="crm-tabs" id="crm-tabs"></div>
        <div class="crm-controls">
          <input id="crm-search" type="search" placeholder="Search deals, company, contact…">
          <select id="crm-stage-filter"></select>
        </div>
        <div class="crm-table-wrap"><table id="crm-table"><thead></thead><tbody></tbody></table></div>
        <div class="crm-pager"><button id="crm-prev">Prev</button><span id="crm-page-info"></span><button id="crm-next">Next</button></div>
      </div>
      <!-- CRM drawer -->
      <div id="crm-drawer" class="lead-drawer">
        <div class="lead-drawer-backdrop" data-crm-close></div>
        <div class="lead-drawer-panel" role="dialog" aria-modal="true">
          <button class="lead-drawer-x" data-crm-close>×</button>
          <div id="crm-drawer-body"></div>
        </div>
      </div>
```

- [ ] **Step 3: Register the nav route**

In `admin/src/js/admin.js`, inside the `navigateTo(page)` switch (lines 422–447), add a case mirroring the `leads` case:
```js
      case 'crm':
        loadCrm();
        break;
```

- [ ] **Step 4: Add a stub `loadCrm()` so navigation works**

At the end of `admin/src/js/admin.js` (after the Leads module), add:
```js
// ===========================================
// CRM MODULE
// ===========================================
function loadCrm() {
  if (loadCrm._wired) { crmReload(); return; }
  loadCrm._wired = true;
  crmInit();
}
function crmInit() { /* A6 fills this */ crmReload(); }
function crmReload() { /* A6 fills this */ }
```

- [ ] **Step 5: Add CRM CSS (reuse leads styles, add pipeline bits)**

Append to `admin/src/css/admin.css` (the leads styles at lines 1467–1650 already cover tabs/table/drawer/pills — add only the new pieces):
```css
/* CRM */
.crm-scoreboard { display:flex; gap:1rem; flex-wrap:wrap; margin-bottom:1rem; }
.crm-stat { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:1rem 1.25rem; min-width:140px; }
.crm-stat .n { font-size:1.6rem; font-weight:600; }
.crm-stat .l { color:#6b7280; font-size:.8rem; text-transform:uppercase; letter-spacing:.5px; }
.crm-controls { display:flex; gap:.75rem; margin:.75rem 0; }
.crm-controls input, .crm-controls select { padding:.5rem .75rem; border:1px solid #d1d5db; border-radius:8px; }
.crm-stage-pill { padding:.15rem .55rem; border-radius:999px; font-size:.75rem; background:#eef2ff; color:#3730a3; }
.crm-motion-services { color:#065f46; } .crm-motion-software { color:#1e40af; }
```

- [ ] **Step 6: Build the admin image and verify the page loads**

Run:
```bash
docker compose build admin && docker compose up -d admin
```
Then verify the built bundle contains the new nav wiring:
```bash
docker exec underwings-admin sh -c "grep -c 'page-crm' /usr/share/nginx/html/index.html"
```
Expected: `1` or more. (Manual: open `/admin/`, log in, click the CRM sidebar item — the empty CRM page should show with no console errors.)

- [ ] **Step 7: Commit**

```bash
git add admin/src/index.html admin/src/js/admin.js admin/src/css/admin.css
git commit -m "feat(crm): admin CRM page shell + nav route"
```

---

### Task A6: Admin CRM — deals board (config-driven table, two motions)

**Files:**
- Modify: `admin/src/js/admin.js` (fill `crmInit`/`crmReload`, add `CRM_TABS`, `crmLoadTab`)

**Interfaces:**
- Consumes: `supabase` client (admin.js:11), `esc`/`formatDate` utils (admin.js:14–40), `crm_deals` + joined `crm_companies`/`crm_contacts`.
- Produces: `crmState`, `CRM_TABS`, `crmLoadTab()`, `crmRenderRows()`. A7 (drawer) calls `crmOpenDrawer(idx)`; A11 (export) calls `crmCurrentQuery()`.

- [ ] **Step 1: Replace the A5 stubs with the tab config + state**

Model this on the Leads module `TAB_CONFIG`/`leadsState`/`loadLeadsTab` at `admin.js` lines 1963–2127. Replace the A5 stub block with:
```js
const CRM_PAGE_SIZE = 25;
let crmState = { tab: 'services', stage: '', search: '', page: 0, rows: [], total: 0 };

const CRM_STAGES = {
  services: ['new','contacted','scoping','proposal_sent','negotiation','won','lost'],
  software: ['new','requirements','quote_sent','po_pending','won','lost'],
  prospects: [], // handled by A9
};

const CRM_TABS = {
  services: {
    motion: 'services',
    columns: [
      { key:'title',   label:'Deal',    render:(r)=>`<div class="lead-email">${esc(r.title||'')}</div><div class="lead-meta">${esc(r.crm_companies?.name||'—')}</div>` },
      { key:'stage',   label:'Stage',   render:(r)=>`<span class="crm-stage-pill">${esc(r.stage)}</span>` },
      { key:'value_aed',label:'Value',  render:(r)=>r.value_aed?`AED ${Number(r.value_aed).toLocaleString()}`:'—' },
      { key:'owner',   label:'Owner',   render:(r)=>esc(r._owner||'—') },
      { key:'next',    label:'Next action', render:(r)=>r.next_action?`${esc(r.next_action)}${r.next_action_date?` · ${r.next_action_date}`:''}`:'—' },
    ],
  },
  software: {
    motion: 'software',
    columns: [
      { key:'title',   label:'Deal',    render:(r)=>`<div class="lead-email">${esc(r.title||'')}</div><div class="lead-meta">${esc(r.crm_companies?.name||'—')}${r.vendor?` · ${esc(r.vendor)}`:''}</div>` },
      { key:'stage',   label:'Stage',   render:(r)=>`<span class="crm-stage-pill">${esc(r.stage)}</span>` },
      { key:'value_aed',label:'Value',  render:(r)=>r.value_aed?`AED ${Number(r.value_aed).toLocaleString()}`:'—' },
      { key:'renewal_date',label:'Renewal', render:(r)=>r.renewal_date||'—' },
      { key:'next',    label:'Next action', render:(r)=>r.next_action?`${esc(r.next_action)}${r.next_action_date?` · ${r.next_action_date}`:''}`:'—' },
    ],
  },
};
```

- [ ] **Step 2: Implement `crmInit` (tabs, controls wiring — once)**

```js
function crmInit() {
  const tabsEl = document.getElementById('crm-tabs');
  tabsEl.innerHTML = ['services','software','prospects'].map((t)=>
    `<button class="leads-tab" data-crm-tab="${t}">${t[0].toUpperCase()+t.slice(1)}</button>`).join('');
  tabsEl.addEventListener('click', (e)=>{
    const b = e.target.closest('[data-crm-tab]'); if(!b) return;
    crmState = { ...crmState, tab: b.dataset.crmTab, stage:'', search:'', page:0 };
    crmSyncStageFilter(); crmReload();
  });
  document.getElementById('crm-search').addEventListener('input', (e)=>{ crmState.search=e.target.value; crmState.page=0; crmDebouncedReload(); });
  document.getElementById('crm-stage-filter').addEventListener('change', (e)=>{ crmState.stage=e.target.value; crmState.page=0; crmReload(); });
  document.getElementById('crm-prev').addEventListener('click', ()=>{ if(crmState.page>0){crmState.page--; crmReload();} });
  document.getElementById('crm-next').addEventListener('click', ()=>{ if((crmState.page+1)*CRM_PAGE_SIZE<crmState.total){crmState.page++; crmReload();} });
  document.querySelectorAll('[data-crm-close]').forEach((el)=>el.addEventListener('click', crmCloseDrawer));
  crmSyncStageFilter();
}
let _crmT; function crmDebouncedReload(){ clearTimeout(_crmT); _crmT=setTimeout(crmReload,250); }
function crmSyncStageFilter(){
  const sel=document.getElementById('crm-stage-filter');
  const stages=CRM_STAGES[crmState.tab]||[];
  sel.innerHTML = `<option value="">All stages</option>`+stages.map((s)=>`<option value="${s}">${s}</option>`).join('');
  sel.style.display = crmState.tab==='prospects' ? 'none' : '';
}
```

- [ ] **Step 3: Implement `crmReload` → `crmLoadTab` (deals) with a company/contact join**

```js
async function crmReload() {
  if (crmState.tab === 'prospects') { crmLoadProspects(); return; }   // A9
  const cfg = CRM_TABS[crmState.tab];
  const from = crmState.page*CRM_PAGE_SIZE, to = from+CRM_PAGE_SIZE-1;
  let q = supabase.from('crm_deals')
    .select('*, crm_companies(name,domain), crm_contacts(name,email,phone,whatsapp_ok)', { count:'exact' })
    .eq('motion', cfg.motion)
    .order('updated_at', { ascending:false })
    .range(from, to);
  if (crmState.stage) q = q.eq('stage', crmState.stage);
  if (crmState.search) {
    const s = crmState.search.replace(/[%,]/g,'');
    q = q.or(`title.ilike.%${s}%,description.ilike.%${s}%`);
  }
  const { data, count, error } = await q;
  if (error) { console.error('[crm] load', error); return; }
  crmState.rows = data||[]; crmState.total = count||0;
  crmRenderRows(cfg);
  crmLoadScoreboard();  // A10
}

function crmRenderRows(cfg) {
  const thead = document.querySelector('#crm-table thead');
  const tbody = document.querySelector('#crm-table tbody');
  thead.innerHTML = `<tr>${cfg.columns.map((c)=>`<th>${c.label}</th>`).join('')}</tr>`;
  tbody.innerHTML = crmState.rows.map((r,i)=>`<tr data-crm-idx="${i}" style="cursor:pointer">${cfg.columns.map((c)=>`<td>${c.render(r)}</td>`).join('')}</tr>`).join('');
  tbody.querySelectorAll('[data-crm-idx]').forEach((tr)=>tr.addEventListener('click',()=>crmOpenDrawer(+tr.dataset.crmIdx)));  // A7
  document.getElementById('crm-page-info').textContent = `${crmState.total} deals`;
}
function crmCurrentQuery(){ return { table:'crm_deals', motion:CRM_TABS[crmState.tab]?.motion }; }  // used by A11
```

- [ ] **Step 4: Manually verify with a seeded deal**

Insert one deal directly, then check it renders. Run:
```bash
docker exec -i underwings-db psql -U postgres -d underwings -c \
"INSERT INTO crm_companies (name,domain) VALUES ('Acme LLC','acme.ae') ON CONFLICT DO NOTHING;
 INSERT INTO crm_deals (title,motion,stage,value_aed,company_id)
 SELECT 'ISO 27001 for Acme','services','scoping',60000,id FROM crm_companies WHERE domain='acme.ae';"
docker compose build admin && docker compose up -d admin
```
Expected (manual): open `/admin/` → CRM → Services tab shows "ISO 27001 for Acme / Acme LLC", stage `scoping`, `AED 60,000`.

- [ ] **Step 5: Commit**

```bash
git add admin/src/js/admin.js
git commit -m "feat(crm): deals board with services/software tabs + search/filter/paging"
```

---

### Task A7: Admin CRM — deal drawer (view, edit, stage change, activity timeline)

**Files:**
- Modify: `admin/src/js/admin.js` (add `crmOpenDrawer`, `crmSaveDeal`, `crmAddActivity`, `crmCloseDrawer`)

**Interfaces:**
- Consumes: `crmState.rows` (A6), `crm_deals`, `crm_activities`, `v_crm_contact_signals`.
- Produces: `crmOpenDrawer(idx)`, `crmCloseDrawer()`. Editing a stage relies on the DB triggers from A1 (status sync + stage-change activity).

- [ ] **Step 1: Implement the drawer open + render**

```js
async function crmOpenDrawer(idx) {
  const d = crmState.rows[idx]; if (!d) return;
  crmState._openId = d.id;
  const stages = CRM_STAGES[d.motion];
  const [{ data: acts }, { data: sig }] = await Promise.all([
    supabase.from('crm_activities').select('*').eq('deal_id', d.id).order('occurred_at',{ascending:false}),
    d.contact_id ? supabase.from('v_crm_contact_signals').select('*').eq('contact_id', d.contact_id).maybeSingle() : Promise.resolve({data:null}),
  ]);
  const badge = sig ? `${sig.is_subscriber?'<span class="crm-stage-pill">newsletter</span>':''}${sig.on_waitlist?' <span class="crm-stage-pill">waitlist</span>':''}` : '';
  const waPhone = (d.crm_contacts?.phone||'').replace(/[^0-9]/g,'');
  const wa = waPhone ? ` · <a href="https://wa.me/${waPhone}" target="_blank" rel="noopener">WhatsApp</a>` : '';
  document.getElementById('crm-drawer-body').innerHTML = `
    <h2>${esc(d.title)}</h2>
    <div class="lead-meta">${esc(d.crm_companies?.name||'—')} · ${esc(d.crm_contacts?.email||'')}${wa} ${badge}</div>
    <label>Stage <select id="crm-d-stage">${stages.map((s)=>`<option ${s===d.stage?'selected':''}>${s}</option>`).join('')}</select></label>
    <label>Value AED <input id="crm-d-value" type="number" value="${d.value_aed??''}"></label>
    <label>Next action <input id="crm-d-next" value="${esc(d.next_action||'')}"></label>
    <label>Next action date <input id="crm-d-nextdate" type="date" value="${d.next_action_date||''}"></label>
    <label>Lost reason <input id="crm-d-lost" value="${esc(d.lost_reason||'')}"></label>
    <button id="crm-d-save" class="btn btn-primary">Save</button>
    <hr>
    <h3>Activity</h3>
    <div class="crm-activity-add">
      <select id="crm-a-type"><option>note</option><option>call</option><option>email</option><option>whatsapp</option><option>meeting</option></select>
      <textarea id="crm-a-body" placeholder="Log a note…"></textarea>
      <button id="crm-a-add" class="btn">Add</button>
    </div>
    <ul id="crm-activity-list">${(acts||[]).map((a)=>`<li><b>${esc(a.type)}</b> · ${formatDate(a.occurred_at)}<br>${esc(a.body||'')}</li>`).join('')}</ul>`;
  document.getElementById('crm-d-save').addEventListener('click', crmSaveDeal);
  document.getElementById('crm-a-add').addEventListener('click', crmAddActivity);
  document.getElementById('crm-drawer').classList.add('open');
}
function crmCloseDrawer(){ document.getElementById('crm-drawer').classList.remove('open'); }
```

- [ ] **Step 2: Implement save + add-activity**

```js
async function crmSaveDeal() {
  const id = crmState._openId;
  const patch = {
    stage: document.getElementById('crm-d-stage').value,
    value_aed: document.getElementById('crm-d-value').value || null,
    next_action: document.getElementById('crm-d-next').value || null,
    next_action_date: document.getElementById('crm-d-nextdate').value || null,
    lost_reason: document.getElementById('crm-d-lost').value || null,
  };
  const { error } = await supabase.from('crm_deals').update(patch).eq('id', id);
  if (error) { alert('Save failed: '+error.message); return; }
  crmCloseDrawer(); crmReload();   // stage-change activity is auto-logged by the DB trigger
}
async function crmAddActivity() {
  const body = document.getElementById('crm-a-body').value.trim(); if(!body) return;
  const type = document.getElementById('crm-a-type').value;
  const { error } = await supabase.from('crm_activities').insert({ deal_id: crmState._openId, type, body });
  if (error) { alert('Add failed: '+error.message); return; }
  crmOpenDrawer(crmState.rows.findIndex((r)=>r.id===crmState._openId));  // refresh drawer
}
```

- [ ] **Step 3: Verify stage change auto-logs an activity**

Manual: open a deal, change stage `scoping → proposal_sent`, Save, reopen — the Activity list shows a `stage_change · Stage: scoping → proposal_sent` entry (written by the A1 trigger). Also confirm in SQL:
```bash
docker exec -i underwings-db psql -U postgres -d underwings -c \
"SELECT type, body FROM crm_activities WHERE type='stage_change' ORDER BY occurred_at DESC LIMIT 3;"
```
Expected: a `stage_change` row with the `→` body.

- [ ] **Step 4: Commit**

```bash
git add admin/src/js/admin.js
git commit -m "feat(crm): deal drawer — edit, stage change, activity timeline"
```

---

### Task A8: Admin CRM — create deal + quick company/contact upsert

**Files:**
- Modify: `admin/src/js/admin.js` (add `crmNewDeal`, `crmUpsertCompany`, `crmUpsertContact`)
- Modify: `admin/src/index.html` (a small new-deal modal)

**Interfaces:**
- Consumes: `crm_companies`, `crm_contacts`, `crm_deals`.
- Produces: `crmUpsertCompany({name,domain})→id`, `crmUpsertContact({email,name,company_id})→id` — reused by the contact form logic pattern in Phase B and by A9 promote.

- [ ] **Step 1: Add a new-deal modal to `index.html`** (after the CRM drawer)

```html
      <div id="crm-newdeal-modal" class="modal">
        <div class="modal-content">
          <h2>New Deal</h2>
          <label>Motion <select id="nd-motion"><option value="services">Services</option><option value="software">Software</option></select></label>
          <label>Title <input id="nd-title"></label>
          <label>Company <input id="nd-company"></label>
          <label>Company domain <input id="nd-domain" placeholder="acme.ae"></label>
          <label>Contact email <input id="nd-email"></label>
          <label>Contact name <input id="nd-name"></label>
          <label>Value AED <input id="nd-value" type="number"></label>
          <div class="modal-actions"><button id="nd-save" class="btn btn-primary">Create</button><button id="nd-cancel" class="btn">Cancel</button></div>
        </div>
      </div>
```
(Match the existing modal markup/classes used by the Posts/Partners editors so the shared `.modal`/`.modal-content` CSS applies.)

- [ ] **Step 2: Implement the upsert helpers + create flow**

```js
async function crmUpsertCompany({ name, domain }) {
  if (domain) {
    const { data } = await supabase.from('crm_companies').select('id').eq('domain', domain.toLowerCase()).maybeSingle();
    if (data) return data.id;
  }
  const { data, error } = await supabase.from('crm_companies').insert({ name: name||domain||'Unknown', domain: domain? domain.toLowerCase():null }).select('id').single();
  if (error) throw error; return data.id;
}
async function crmUpsertContact({ email, name, company_id, phone, job_title }) {
  if (email) {
    const { data } = await supabase.from('crm_contacts').select('id').eq('email', email.toLowerCase()).maybeSingle();
    if (data) return data.id;
  }
  const { data, error } = await supabase.from('crm_contacts').insert({ email: email? email.toLowerCase():null, name, company_id, phone, job_title }).select('id').single();
  if (error) throw error; return data.id;
}
function crmWireNewDeal() {
  document.getElementById('crm-new-deal-btn').addEventListener('click', ()=>document.getElementById('crm-newdeal-modal').classList.add('open'));
  document.getElementById('nd-cancel').addEventListener('click', ()=>document.getElementById('crm-newdeal-modal').classList.remove('open'));
  document.getElementById('nd-save').addEventListener('click', crmNewDeal);
}
async function crmNewDeal() {
  try {
    const companyId = await crmUpsertCompany({ name: val('nd-company'), domain: val('nd-domain') });
    const contactId = val('nd-email') ? await crmUpsertContact({ email: val('nd-email'), name: val('nd-name'), company_id: companyId }) : null;
    const { error } = await supabase.from('crm_deals').insert({
      title: val('nd-title')||'Untitled', motion: val('nd-motion'), stage:'new',
      value_aed: val('nd-value')||null, company_id: companyId, contact_id: contactId, source:'other',
    });
    if (error) throw error;
    document.getElementById('crm-newdeal-modal').classList.remove('open'); crmReload();
  } catch (e) { alert('Create failed: '+e.message); }
}
function val(id){ return document.getElementById(id).value.trim(); }
```
Add `crmWireNewDeal();` to the end of `crmInit()` (A6 Step 2).

- [ ] **Step 3: Verify create flow**

Manual: CRM → "+ New Deal" → fill Title "Web App PT", Company "Beta FZ", domain "beta.ae", email "cto@beta.ae", value 20000 → Create. The Services board shows the new deal; `crm_companies`/`crm_contacts` each have one new row:
```bash
docker exec -i underwings-db psql -U postgres -d underwings -c "SELECT count(*) FROM crm_deals; SELECT domain FROM crm_companies WHERE domain='beta.ae';"
```
Expected: deal count incremented, `beta.ae` present.

- [ ] **Step 4: Commit**

```bash
git add admin/src/js/admin.js admin/src/index.html
git commit -m "feat(crm): create deal + company/contact upsert helpers"
```

---

### Task A9: Admin CRM — prospects tab + Promote-to-deal

**Files:**
- Modify: `admin/src/js/admin.js` (add `crmLoadProspects`, `crmPromoteProspect`)

**Interfaces:**
- Consumes: `crm_prospects`, `crm_prospect_contacts`, `crmUpsertCompany`/`crmUpsertContact` (A8).
- Produces: `crmLoadProspects()` (called by A6 `crmReload` when tab==='prospects'), `crmPromoteProspect(id)`.

- [ ] **Step 1: Implement the prospects list**

```js
async function crmLoadProspects() {
  const from = crmState.page*CRM_PAGE_SIZE, to = from+CRM_PAGE_SIZE-1;
  let q = supabase.from('crm_prospects')
    .select('*', { count:'exact' })
    .neq('status','suppressed')
    .order('ai_score', { ascending:false, nullsFirst:false })
    .range(from, to);
  if (crmState.search) { const s=crmState.search.replace(/[%,]/g,''); q=q.or(`company_name.ilike.%${s}%,domain.ilike.%${s}%`); }
  const { data, count, error } = await q;
  if (error) { console.error('[crm] prospects', error); return; }
  crmState.rows = data||[]; crmState.total = count||0;
  const thead=document.querySelector('#crm-table thead'), tbody=document.querySelector('#crm-table tbody');
  thead.innerHTML = `<tr><th>Company</th><th>AI</th><th>Gap</th><th>Status</th><th>Talking points</th><th></th></tr>`;
  tbody.innerHTML = crmState.rows.map((r,i)=>`<tr>
    <td><div class="lead-email">${esc(r.company_name)}</div><div class="lead-meta">${esc(r.domain||'')}</div></td>
    <td>${r.ai_score??'—'}</td><td>${r.gap_score??'—'}</td>
    <td><span class="crm-stage-pill">${esc(r.status)}</span></td>
    <td>${esc((r.talking_points||'').slice(0,120))}</td>
    <td>${r.status==='promoted'?'✓':`<button class="btn" data-promote="${r.id}">Promote</button>`}</td></tr>`).join('');
  tbody.querySelectorAll('[data-promote]').forEach((b)=>b.addEventListener('click',()=>crmPromoteProspect(b.dataset.promote)));
  document.getElementById('crm-page-info').textContent = `${crmState.total} prospects`;
}
```

- [ ] **Step 2: Implement promote (prospect → company+contact+deal)**

```js
async function crmPromoteProspect(id) {
  const { data: p } = await supabase.from('crm_prospects').select('*').eq('id', id).single();
  const { data: pcs } = await supabase.from('crm_prospect_contacts').select('*').eq('prospect_id', id).order('confidence',{ascending:false});
  const top = (pcs||[])[0] || {};
  try {
    const companyId = await crmUpsertCompany({ name: p.company_name, domain: p.domain });
    const contactId = top.email ? await crmUpsertContact({ email: top.email, name: top.name, company_id: companyId, phone: top.phone, job_title: top.job_title }) : null;
    const { data: deal, error } = await supabase.from('crm_deals').insert({
      title: `${p.company_name} — outbound`, motion:'services', stage:'new',
      company_id: companyId, contact_id: contactId, source:'leadgen',
      ai_score: p.ai_score, description: p.talking_points, icp_segment: 'other',
    }).select('id').single();
    if (error) throw error;
    await supabase.from('crm_prospects').update({ status:'promoted', promoted_deal_id: deal.id }).eq('id', id);
    crmReload();
  } catch (e) { alert('Promote failed: '+e.message); }
}
```

- [ ] **Step 3: Verify with a seeded prospect**

```bash
docker exec -i underwings-db psql -U postgres -d underwings -c \
"INSERT INTO crm_prospects (company_name,domain,ai_score,gap_score,talking_points,source,dedupe_key,status,enrichment_status)
 VALUES ('Cold Co','coldco.ae',8,6,'Missing DMARC; 3 subdomains exposed','leadgen','d:coldco.ae','enriched','enriched')
 ON CONFLICT (dedupe_key) DO NOTHING;"
```
Manual: CRM → Prospects tab shows "Cold Co" with AI 8 / Gap 6. Click Promote → a new Services deal "Cold Co — outbound" appears; prospect row now shows ✓. Confirm:
```bash
docker exec -i underwings-db psql -U postgres -d underwings -c "SELECT status, promoted_deal_id IS NOT NULL AS promoted FROM crm_prospects WHERE dedupe_key='d:coldco.ae';"
```
Expected: `promoted | t`.

- [ ] **Step 4: Commit**

```bash
git add admin/src/js/admin.js
git commit -m "feat(crm): prospects tab + promote-to-deal"
```

---

### Task A10: Admin CRM — scoreboard + pipeline chart

**Files:**
- Modify: `admin/src/js/admin.js` (add `crmLoadScoreboard`, `crmRenderPipelineChart`)
- Modify: `admin/src/index.html` (a `<canvas id="crm-chart-pipeline">` inside `#page-crm`)

**Interfaces:**
- Consumes: `v_crm_quarter_scoreboard`, `v_crm_pipeline`, `v_crm_stale_deals`, `v_crm_renewals_next_90d`; `Chart` (admin.js:7).
- Produces: `crmLoadScoreboard()` (called from A6 `crmReload`).

- [ ] **Step 1: Add the chart canvas to `index.html`** (inside `#page-crm`, after `#crm-scoreboard`)
```html
        <div class="crm-chart-wrap"><canvas id="crm-chart-pipeline" height="120"></canvas></div>
```

- [ ] **Step 2: Implement the scoreboard + chart (reuse the analytics Chart.js destroy-then-new pattern at admin.js:1622–1631)**

```js
let crmPipelineChart = null;
async function crmLoadScoreboard() {
  const [{ data: sb }, { data: pipe }, { data: stale }, { data: renew }] = await Promise.all([
    supabase.from('v_crm_quarter_scoreboard').select('*').maybeSingle(),
    supabase.from('v_crm_pipeline').select('*'),
    supabase.from('v_crm_stale_deals').select('id', { count:'exact', head:true }),
    supabase.from('v_crm_renewals_next_90d').select('id', { count:'exact', head:true }),
  ]);
  const staleCount = stale?.length ?? 0; // head:true returns count via .count; fallback shown below
  const s = sb || {};
  const stat = (n,l)=>`<div class="crm-stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  document.getElementById('crm-scoreboard').innerHTML =
    stat(s.won_count??0,'Won this qtr (target 3)') +
    stat(`AED ${Number(s.won_value_aed??0).toLocaleString()}`,'Won value') +
    stat(`${s.win_rate_pct??0}%`,'Win rate (target 40%)') +
    stat(`AED ${Number(s.avg_won_aed??0).toLocaleString()}`,'Avg deal (target 35k)');
  crmRenderPipelineChart(pipe||[]);
}
function crmRenderPipelineChart(rows) {
  const ctx = document.getElementById('crm-chart-pipeline')?.getContext('2d'); if(!ctx) return;
  if (crmPipelineChart) crmPipelineChart.destroy();
  const services = rows.filter((r)=>r.motion==='services');
  const software = rows.filter((r)=>r.motion==='software');
  const stages = [...new Set(rows.map((r)=>r.stage))];
  crmPipelineChart = new Chart(ctx, {
    type:'bar',
    data:{ labels:stages, datasets:[
      { label:'Services (AED)', data:stages.map((st)=>services.find((r)=>r.stage===st)?.value_aed||0) },
      { label:'Software (AED)', data:stages.map((st)=>software.find((r)=>r.stage===st)?.value_aed||0) },
    ]},
    options:{ responsive:true, plugins:{legend:{position:'bottom'}}, scales:{y:{beginAtZero:true}} },
  });
}
```
Note: for the stale/renewal counts, use the `count` returned by a `head:true` query — read `const { count } = await supabase...` rather than `.length`. Fix the destructuring accordingly when implementing (the pattern is `const { count: staleCount } = await supabase.from('v_crm_stale_deals').select('*', { count:'exact', head:true });`).

- [ ] **Step 3: Verify the scoreboard renders**

Manual: with the seeded won deal from A6/A8, CRM page top shows four stat tiles and a pipeline bar chart with services/software series. No console errors.

- [ ] **Step 4: Commit**

```bash
git add admin/src/js/admin.js admin/src/index.html
git commit -m "feat(crm): scoreboard tiles + pipeline chart"
```

---

### Task A11: Admin CRM — CSV export

**Files:**
- Modify: `admin/src/js/admin.js` (add `crmExport`, reuse `csvCell` at admin.js:2213)

**Interfaces:**
- Consumes: `crmCurrentQuery()` (A6), existing `csvCell()` helper (admin.js:2213–2218).

- [ ] **Step 1: Implement export by cloning the Leads `exportLeadsCSV` (admin.js:2187–2212)**

```js
async function crmExport() {
  const tab = crmState.tab;
  let data, cols;
  if (tab === 'prospects') {
    ({ data } = await supabase.from('crm_prospects').select('*').limit(5000));
  } else {
    ({ data } = await supabase.from('crm_deals').select('*, crm_companies(name), crm_contacts(email)').eq('motion', CRM_TABS[tab].motion).limit(5000));
  }
  if (!data || !data.length) { alert('Nothing to export'); return; }
  cols = Object.keys(data[0]).filter((c)=>typeof data[0][c] !== 'object');
  const rows = [cols.join(',')];
  for (const r of data) rows.push(cols.map((c)=>csvCell(r[c])).join(','));
  const blob = new Blob([rows.join('\n')], { type:'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `underwings-crm-${tab}-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}
```
Wire it in `crmInit()`: `document.getElementById('crm-export-btn').addEventListener('click', crmExport);`

- [ ] **Step 2: Verify**

Manual: CRM → Services → Export CSV downloads `underwings-crm-services-YYYY-MM-DD.csv` containing the seeded deals. Open it — header row + data rows present.

- [ ] **Step 3: Build, deploy, commit**

```bash
docker compose build admin && docker compose up -d admin
git add admin/src/js/admin.js
git commit -m "feat(crm): CSV export per tab"
```

**► Phase A ships here: a working deal board with pipelines, drawer, prospects, reporting, and export.**

---

## Phase B — inbound wiring (ships: website leads land in the CRM automatically)

### Task B1: Fix the contact-form field-mapping bugs

**Files:**
- Modify: `frontend/src/pages/api/contact.ts` (lines 267–268)

**Interfaces:**
- Produces: correct `message` (free text) and `service` (the chosen service slug) locals used by the Supabase insert (lines 273–282) and the notify/auto-reply calls.

- [ ] **Step 1: Fix the two lines**

In `frontend/src/pages/api/contact.ts`, replace lines 267–268:
```ts
const message = fields.what_can_we_help_with_ || fields.message || null;
const service = fields.service_interest || null;
```
with:
```ts
// service dropdown arrives under the legacy key `what_can_we_help_with_`; free text under `message`
const service = fields.service_interest || fields.what_can_we_help_with_ || fields.intent || null;
const message = fields.message || null;
```

- [ ] **Step 2: Verify the mapping locally with a curl against the running frontend**

Run:
```bash
docker compose up -d frontend
curl -s -X POST http://localhost:4321/api/contact -H 'Content-Type: application/json' \
  -d '{"fields":[{"name":"email","value":"bugtest@example.ae"},{"name":"firstname","value":"Bug Test"},{"name":"what_can_we_help_with_","value":"iso-27001-implementation"},{"name":"message","value":"We need ISO cert before a tender."}],"cf-turnstile-response":"x"}' -w '\n%{http_code}\n'
```
(Turnstile may reject `x` in prod; for local verify, if the route enforces Turnstile, temporarily test by asserting the DB row instead.) Then check the stored row:
```bash
docker exec -i underwings-db psql -U postgres -d underwings -c \
"SELECT service_interest, message FROM form_submissions WHERE email='bugtest@example.ae' ORDER BY created_at DESC LIMIT 1;"
```
Expected: `service_interest = iso-27001-implementation`, `message = We need ISO cert before a tender.` (message is the real text, not the slug).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/api/contact.ts
git commit -m "fix(contact): map service_interest + free-text message correctly"
```

---

### Task B2: Parse `?intent=quote-*` on the contact form

**Files:**
- Modify: `frontend/src/pages/index.astro` (contact form submit JS near lines 1937/1968–1995)

**Interfaces:**
- Produces: an `intent` field appended to the POST payload + preselects `#ctf-service` when a matching option exists.

- [ ] **Step 1: Add intent parsing to the form init JS**

In `frontend/src/pages/index.astro`, inside the contact-form script (near line 1937, before the submit handler), add:
```js
// Carry ?intent=quote-* from the software page (it rides in location.hash after #contact)
(function preselectIntent(){
  var raw = (location.hash || '') + (location.search || '');
  var m = raw.match(/intent=([a-z0-9\-]+)/i);
  if (!m) return;
  var intent = m[1];
  window.__ctfIntent = intent;
  var sel = document.querySelector('#ctf-service');
  if (sel) { for (var i=0;i<sel.options.length;i++){ if (sel.options[i].value === intent){ sel.selectedIndex = i; break; } } }
})();
```

- [ ] **Step 2: Append the intent to the payload**

In the payload `fields` array (lines ~1977–1989), add one entry:
```js
    { name: 'intent', value: window.__ctfIntent || '' },
```

- [ ] **Step 3: Verify**

Run `docker compose build frontend && docker compose up -d frontend`. Manual: visit `/#contact?intent=quote-siem` — the service dropdown preselects the SIEM option (if present); submitting includes `intent: "quote-siem"`. Confirm via the resulting `form_submissions.service_interest` (B1 makes `intent` a fallback) — for a software intent it should store `quote-siem` when the dropdown has no exact match.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/index.astro
git commit -m "feat(contact): parse ?intent=quote-* and preselect service"
```

---

### Task B3: Contact form writes CRM rows directly

**Files:**
- Modify: `frontend/src/pages/api/contact.ts` (after the `form_submissions` insert, ~line 286)

**Interfaces:**
- Consumes: the existing service-role `supabase` client (contact.ts:193–198), `crm_companies`/`crm_contacts`/`crm_deals`/`crm_activities`.
- Produces: on each contact submission — a company (by domain), a contact (by email), a deal, and a note activity.

- [ ] **Step 1: Add a CRM-write helper to contact.ts**

Add this function in `frontend/src/pages/api/contact.ts` (module scope, near the other helpers):
```ts
const SOFTWARE_INTENTS = new Set(['software-quote','quote-endpoint','quote-siem','quote-email','quote-network','quote-iam','quote-cloud','quote-vm','quote-backup']);

async function writeCrmLead(supabase: any, args: { email: string; name: string|null; phone: string|null; company: string|null; service: string|null; message: string|null; }) {
  try {
    const domain = args.email && args.email.includes('@') ? args.email.split('@')[1].toLowerCase() : null;
    // company by domain
    let companyId: string|null = null;
    if (domain) {
      const { data: c } = await supabase.from('crm_companies').select('id').eq('domain', domain).maybeSingle();
      companyId = c?.id ?? (await supabase.from('crm_companies').insert({ name: args.company || domain, domain }).select('id').single()).data?.id ?? null;
    } else if (args.company) {
      companyId = (await supabase.from('crm_companies').insert({ name: args.company }).select('id').single()).data?.id ?? null;
    }
    // contact by email
    let contactId: string|null = null;
    if (args.email) {
      const { data: ct } = await supabase.from('crm_contacts').select('id').eq('email', args.email.toLowerCase()).maybeSingle();
      contactId = ct?.id ?? (await supabase.from('crm_contacts').insert({ email: args.email.toLowerCase(), name: args.name, phone: args.phone, company_id: companyId }).select('id').single()).data?.id ?? null;
    }
    const motion = args.service && SOFTWARE_INTENTS.has(args.service) ? 'software' : 'services';
    const { data: deal } = await supabase.from('crm_deals').insert({
      title: `${args.service || 'Enquiry'} — ${args.company || args.email}`,
      motion, stage: 'new',
      source: args.service && args.service.startsWith('quote') ? 'quote_intent' : 'web_form',
      offering: args.service || null, company_id: companyId, contact_id: contactId,
      description: args.message,
    }).select('id').single();
    if (deal?.id && args.message) {
      await supabase.from('crm_activities').insert({ deal_id: deal.id, type: 'note', body: args.message });
    }
  } catch (e) { console.error('[contact] CRM write failed:', e); } // never block the form response
}
```

- [ ] **Step 2: Call it alongside the existing insert**

In the `Promise.all` block (contact.ts ~lines 272–286), add `writeCrmLead(...)` as an additional awaited promise:
```ts
    writeCrmLead(supabase, { email, name, phone, company, service, message }),
```
Keep the existing `form_submissions` insert (raw archive) and remove/keep `pushToKrayinCRM` — since it's a confirmed no-op, replace the `pushToKrayinCRM(...)` line with the new `writeCrmLead(...)` call.

- [ ] **Step 3: Verify end-to-end**

Run `docker compose build frontend && docker compose up -d frontend`. Submit a contact (curl as in B1 with a fresh email `crmwrite@beta.ae`, service `web-app-pentest`). Then:
```bash
docker exec -i underwings-db psql -U postgres -d underwings -c \
"SELECT d.title, d.motion, d.source, co.domain, ct.email FROM crm_deals d
 LEFT JOIN crm_companies co ON co.id=d.company_id LEFT JOIN crm_contacts ct ON ct.id=d.contact_id
 WHERE ct.email='crmwrite@beta.ae';"
```
Expected: one services deal, source `web_form`, company domain `beta.ae`, contact `crmwrite@beta.ae`. Submitting again with the same email must NOT create a duplicate company/contact (dedupe by domain/email) — re-run and confirm counts stay sane.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/api/contact.ts
git commit -m "feat(contact): write CRM company/contact/deal/activity on submit"
```

---

### Task B4: Newsletter — no deal, verify email-match badge only

**Files:**
- Modify: `frontend/src/pages/api/newsletter.ts` (remove the dead `notifyN8nInbound`/`pushToKeila` no-op calls only if desired — optional cleanup)

**Interfaces:**
- Consumes: `v_crm_contact_signals` (A2) already surfaces newsletter membership in the deal drawer (A7). No deal is created for newsletter signups.

- [ ] **Step 1: Confirm no CRM deal is created for newsletter (by design)**

No code change required for CRM behaviour — newsletter continues to write `subscribers` only. Optionally remove the confirmed-dead `pushToKeila` and `notifyN8nInbound` calls from `newsletter.ts` (they no-op). If removing, delete their invocations in the `Promise.all` (lines ~206–226) and the now-unused imports.

- [ ] **Step 2: Verify the badge path**

Insert a subscriber whose email matches an existing CRM contact, then open that contact's deal drawer — the `newsletter` badge shows (via `v_crm_contact_signals`). SQL check:
```bash
docker exec -i underwings-db psql -U postgres -d underwings -c \
"INSERT INTO subscribers (email, subscribed) VALUES ('crmwrite@beta.ae', true) ON CONFLICT (email) DO UPDATE SET subscribed=true;
 SELECT is_subscriber FROM v_crm_contact_signals WHERE email='crmwrite@beta.ae';"
```
Expected: `is_subscriber = t`.

- [ ] **Step 3: Commit (only if you made the optional cleanup)**

```bash
git add frontend/src/pages/api/newsletter.ts
git commit -m "chore(newsletter): drop dead krayin/n8n no-op calls"
```

---

### Task B5: Owner email notification on new deal (Stalwart SMTP)

**Files:**
- Modify: `frontend/src/pages/api/contact.ts` (reuse existing `notifyTeam` SMTP path)

**Interfaces:**
- Consumes: the existing `notifyTeam()` helper (already called at contact.ts:285) and SMTP env (`SMTP_HOST=stalwart`, etc.).

- [ ] **Step 1: Confirm the existing team notification covers "new deal" for inbound**

`notifyTeam(name,email,phone,company,service,message)` already fires on every contact submission via SMTP to the team. Since inbound deals are created in B3, the existing email IS the new-deal notification for inbound. Ensure the email body links to `https://crm.underwings.org/admin/` (which A4 redirects to the CRM). Update the `notifyTeam` template's CRM link if it points at the old Krayin path.

- [ ] **Step 2: Verify the link text**

Search `frontend/src/pages/api/contact.ts` for any `crm.underwings.org` link in `notifyTeam`; ensure it reads `https://crm.underwings.org/admin/`. If a different CRM URL is hardcoded, fix it.
```bash
grep -n "crm.underwings.org\|View in CRM\|/admin" frontend/src/pages/api/contact.ts
```

- [ ] **Step 3: Commit (if changed)**

```bash
git add frontend/src/pages/api/contact.ts
git commit -m "chore(contact): point team-notification CRM link at /admin"
```

---

### Task B6: Remove Cal.com / book.underwings.org links

**Files:**
- Modify: any frontend files linking to `book.underwings.org` / Cal.com

**Interfaces:**
- Produces: no booking links remain on the site (Cal.com dropped per spec).

- [ ] **Step 1: Find all booking links**

Run:
```bash
grep -rn "book.underwings.org\|cal.com\|calendly\|Book a call\|Schedule a call" frontend/src/ | grep -v node_modules
```

- [ ] **Step 2: Replace each with the contact anchor**

For each hit, replace the booking URL with `/#contact` (or remove the CTA if redundant). Keep copy sensible ("Talk to us" → `/#contact`).

- [ ] **Step 3: Verify none remain + build**

Run the grep from Step 1 again — expect no results (or only non-link mentions). Then:
```bash
docker compose build frontend && docker compose up -d frontend
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src
git commit -m "chore(site): remove Cal.com/book.underwings.org booking links"
```

**► Phase B ships here: website contact + software-quote leads flow straight into the CRM pipeline; newsletter shows as a signal; booking removed.**

---

## Phase C — leadgen OSINT rework (ships: cold prospects flow into the CRM with $0 enrichment)

### Task C1: `lib/crm.js` — Supabase sink (zero-dep PostgREST client)

**Files:**
- Create: `leadgen/lib/crm.js`
- Create: `leadgen/test/crm.test.js`

**Interfaces:**
- Consumes: `lib/http.js` `request` (leadgen/lib/http.js). Env `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- Produces: `makeCrmClient(url, serviceKey)` → `{ upsertProspect(prospect), addProspectContacts(prospectId, contacts[]), listSuppressed() }`. Replaces the `lib/sheets.js` `write`/`batchWrite` interface used in `run.js`.

- [ ] **Step 1: Write the failing test (Node built-in `node:test`, zero-dep)**

Create `leadgen/test/crm.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { buildProspectRow, dedupeKeyFor } = require('../lib/crm.js');

test('dedupeKeyFor prefers domain', () => {
  assert.strictEqual(dedupeKeyFor({ domain: 'Acme.AE', company: 'Acme LLC' }), 'd:acme.ae');
  assert.strictEqual(dedupeKeyFor({ company: 'Beta  FZ' }), 'c:beta fz');
});

test('buildProspectRow maps lead fields to prospect columns', () => {
  const row = buildProspectRow({ company:'Acme', domain:'acme.ae', website:'https://acme.ae', industry:'IT', icp_score:8, gap_score:5, talking_points:'Missing DMARC', source:'overpass', summary:'x', opener:'y' });
  assert.strictEqual(row.company_name, 'Acme');
  assert.strictEqual(row.ai_score, 8);
  assert.strictEqual(row.gap_score, 5);
  assert.strictEqual(row.dedupe_key, 'd:acme.ae');
  assert.strictEqual(row.status, 'enriched');
  assert.strictEqual(row.enrichment_status, 'enriched');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd leadgen && node --test`
Expected: FAIL — `Cannot find module '../lib/crm.js'`.

- [ ] **Step 3: Implement `lib/crm.js`**

Create `leadgen/lib/crm.js`:
```js
'use strict';
const { request } = require('./http.js');

function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function dedupeKeyFor(lead) {
  const d = norm(lead.domain);
  if (d) return `d:${d}`;
  return `c:${norm(lead.company)}`;
}
function buildProspectRow(lead) {
  return {
    company_name: lead.company || lead.domain || 'Unknown',
    domain: lead.domain ? norm(lead.domain) : null,
    website: lead.website || null,
    industry: lead.industry || null,
    emirate: lead.emirate || null,
    size_band: lead.size_band || null,
    ai_score: Number.isFinite(lead.icp_score) ? lead.icp_score : null,
    gap_score: Number.isFinite(lead.gap_score) ? lead.gap_score : null,
    talking_points: lead.talking_points || null,
    source: lead.source || null,
    dedupe_key: dedupeKeyFor(lead),
    enrichment_status: 'enriched',
    status: 'enriched',
    notes: [lead.summary, lead.opener ? `Opener: ${lead.opener}` : ''].filter(Boolean).join(' | ') || null,
  };
}

function makeCrmClient(url, serviceKey) {
  const base = url.replace(/\/$/, '') + '/rest/v1';
  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  async function upsertProspect(lead) {
    const row = buildProspectRow(lead);
    // upsert on dedupe_key; return the row id
    const res = await request(`${base}/crm_prospects?on_conflict=dedupe_key`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(row),
    });
    const j = await res.json();
    return Array.isArray(j) && j[0] ? j[0].id : null;
  }
  async function addProspectContacts(prospectId, contacts) {
    if (!prospectId || !contacts || !contacts.length) return;
    const rows = contacts.map((c) => ({
      prospect_id: prospectId,
      name: c.name || null, job_title: c.title || c.job_title || null,
      email: c.email ? norm(c.email) : null, email_status: c.emailStatus || c.email_status || null,
      phone: c.phone || null, linkedin_url: c.linkedin || c.linkedin_url || null,
      source: c.source || 'scrape', confidence: Number.isFinite(c.confidence) ? c.confidence : null,
    }));
    await request(`${base}/crm_prospect_contacts`, {
      method: 'POST', headers: { ...headers, 'Prefer': 'return=minimal' }, body: JSON.stringify(rows),
    });
  }
  async function listSuppressed() {
    const res = await request(`${base}/crm_suppression?select=email`, { headers });
    const j = await res.json();
    return new Set((j || []).map((r) => norm(r.email)));
  }
  return { upsertProspect, addProspectContacts, listSuppressed };
}

module.exports = { makeCrmClient, buildProspectRow, dedupeKeyFor };
```

- [ ] **Step 4: Run the test — pass**

Run: `cd leadgen && node --test`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add leadgen/lib/crm.js leadgen/test/crm.test.js
git commit -m "feat(leadgen): Supabase CRM sink (zero-dep PostgREST) + tests"
```

---

### Task C2: `budget.js` — add a daily counter variant

**Files:**
- Modify: `leadgen/lib/budget.js`
- Create: `leadgen/test/budget.test.js`

**Interfaces:**
- Produces: `usedDay(name)`, `remainingDay(name, cap)`, `spendDay(name, n)` — a daily (`YYYY-MM-DD`) counter stored **separately** so it doesn't clobber the monthly counter (whose `save({[m]:cur})` keeps only the current month).

- [ ] **Step 1: Write the failing test**

Create `leadgen/test/budget.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const budget = require('../lib/budget.js');

test('daily counter exports exist and are independent of monthly', () => {
  assert.strictEqual(typeof budget.usedDay, 'function');
  assert.strictEqual(typeof budget.remainingDay, 'function');
  assert.strictEqual(typeof budget.spendDay, 'function');
});
```

- [ ] **Step 2: Run → fail**

Run: `cd leadgen && node --test test/budget.test.js`
Expected: FAIL — `budget.usedDay is not a function`.

- [ ] **Step 3: Implement the daily variant with a separate store file**

In `leadgen/lib/budget.js`, add alongside the monthly functions (keep the monthly ones unchanged):
```js
const DAILY_PATH = path.join(__dirname, '..', 'state', 'usage-daily.json');
const day = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD
function loadDay() { try { return JSON.parse(fs.readFileSync(DAILY_PATH, 'utf8')); } catch { return {}; } }
function saveDay(d) { try { fs.writeFileSync(DAILY_PATH, JSON.stringify(d)); } catch {} }
function usedDay(name) { return (loadDay()[day()] || {})[name] || 0; }
function remainingDay(name, cap) { return Math.max(0, cap - usedDay(name)); }
function spendDay(name, n = 1) {
  const d = loadDay(); const k = day(); const cur = d[k] || {};
  cur[name] = (cur[name] || 0) + n;
  saveDay({ [k]: cur }); // keep only current day
  return cur[name];
}
```
Update the exports line to include them:
```js
module.exports = { used, remaining, spend, usedDay, remainingDay, spendDay };
```

- [ ] **Step 4: Run → pass**

Run: `cd leadgen && node --test test/budget.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add leadgen/lib/budget.js leadgen/test/budget.test.js
git commit -m "feat(leadgen): daily budget counter (separate store from monthly)"
```

---

### Task C3: In-house email permutator

**Files:**
- Create: `leadgen/lib/permute.js`
- Create: `leadgen/test/permute.test.js`

**Interfaces:**
- Produces: `permuteEmails(fullName, domain, patterns?)` → `string[]` of candidate addresses tagged for `email_status='probable'` upstream.

- [ ] **Step 1: Write the failing test**

Create `leadgen/test/permute.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { permuteEmails } = require('../lib/permute.js');

test('permuteEmails builds common patterns', () => {
  const out = permuteEmails('Jane Doe', 'Acme.AE');
  assert.ok(out.includes('jane.doe@acme.ae'));
  assert.ok(out.includes('jdoe@acme.ae'));
  assert.ok(out.includes('jane@acme.ae'));
  assert.ok(out.every((e) => e.endsWith('@acme.ae')));
});
test('permuteEmails returns [] on bad input', () => {
  assert.deepStrictEqual(permuteEmails('', 'acme.ae'), []);
  assert.deepStrictEqual(permuteEmails('Jane Doe', ''), []);
});
```

- [ ] **Step 2: Run → fail** — `cd leadgen && node --test test/permute.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `lib/permute.js`**
```js
'use strict';
const DEFAULT_PATTERNS = ['first.last', 'flast', 'first', 'f.last', 'firstl', 'lastf', 'last'];
function permuteEmails(fullName, domain, patterns = DEFAULT_PATTERNS) {
  const d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  const parts = String(fullName || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!d || parts.length < 1) return [];
  const first = parts[0], last = parts[parts.length - 1];
  const f = first[0] || '', l = last[0] || '';
  const map = {
    'first.last': `${first}.${last}`, 'flast': `${f}${last}`, 'first': first,
    'f.last': `${f}.${last}`, 'firstl': `${first}${l}`, 'lastf': `${last}${f}`, 'last': last,
  };
  const seen = new Set();
  const out = [];
  for (const p of patterns) {
    const local = map[p];
    if (local && !seen.has(local)) { seen.add(local); out.push(`${local}@${d}`); }
  }
  return out;
}
module.exports = { permuteEmails, DEFAULT_PATTERNS };
```

- [ ] **Step 4: Run → pass** — `cd leadgen && node --test test/permute.test.js` → PASS.

- [ ] **Step 5: Commit**
```bash
git add leadgen/lib/permute.js leadgen/test/permute.test.js
git commit -m "feat(leadgen): in-house email permutator + tests"
```

---

### Task C4: `lib/osint.js` — free security-signal enrichment (DNS/DMARC + PD binaries + breach)

**Files:**
- Create: `leadgen/lib/osint.js`
- Create: `leadgen/test/osint.test.js`

**Interfaces:**
- Consumes: native `node:dns/promises`, `node:child_process` (subfinder/dnsx/httpx), `lib/http.js` (XposedOrNot), `lib/budget.js` daily caps.
- Produces: `enrichSecurity(domain, opts)` → `{ subdomainCount, tech:[], mxProvider, hasDmarc, hasSpf, breachCount, gap_score, talking_points }`. Called by run.js pipeline (C6). All steps are best-effort and swallow errors (never throw).

- [ ] **Step 1: Write the failing test (pure scoring logic only — no network)**

Create `leadgen/test/osint.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { scoreGaps } = require('../lib/osint.js');

test('scoreGaps rewards missing DMARC + breaches + exposed subdomains', () => {
  const a = scoreGaps({ hasDmarc:false, hasSpf:false, breachCount:5, subdomainCount:12, tech:['WordPress'] });
  const b = scoreGaps({ hasDmarc:true, hasSpf:true, breachCount:0, subdomainCount:1, tech:[] });
  assert.ok(a.gap_score > b.gap_score);
  assert.match(a.talking_points, /DMARC/i);
});
```

- [ ] **Step 2: Run → fail** — `cd leadgen && node --test test/osint.test.js` → FAIL.

- [ ] **Step 3: Implement `lib/osint.js`**
```js
'use strict';
const dns = require('node:dns').promises;
const { execFile } = require('node:child_process');
const { request } = require('./http.js');
const budget = require('./budget.js');

function run(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

async function mxProvider(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    const host = (mx.sort((a, b) => a.priority - b.priority)[0] || {}).exchange || '';
    if (/protection\.outlook\.com|office365/i.test(host)) return 'microsoft365';
    if (/google|googlemail|aspmx/i.test(host)) return 'google';
    return host ? 'other' : null;
  } catch { return null; }
}
async function dmarcSpf(domain) {
  let hasDmarc = false, hasSpf = false;
  try { const t = await dns.resolveTxt(`_dmarc.${domain}`); hasDmarc = t.flat().some((r) => /v=DMARC1/i.test(r)); } catch {}
  try { const t = await dns.resolveTxt(domain); hasSpf = t.flat().some((r) => /v=spf1/i.test(r)); } catch {}
  return { hasDmarc, hasSpf };
}
async function subdomains(domain, opts) {
  if (!opts.subfinder) return [];
  const out = await run('subfinder', ['-silent', '-d', domain, '-timeout', '30']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}
async function techFingerprint(domain, opts) {
  if (!opts.httpx) return [];
  const out = await run('httpx', ['-silent', '-json', '-tech-detect', '-u', domain]);
  const tech = new Set();
  for (const line of out.split('\n')) { try { const j = JSON.parse(line); (j.tech || j.technologies || []).forEach((t) => tech.add(t)); } catch {} }
  return [...tech];
}
async function breachCountForEmail(email, opts) {
  // Spec §6.2: domain-wide breach search is OWNER-GATED — for prospects we don't own, use the
  // keyless EMAIL-level endpoint on a harvested role email. Aggregate signal only; never store creds.
  if (!opts.enabled || !email) return 0;
  if (budget.remainingDay('xposedornot', opts.breachDailyCap || 40) <= 0) return 0;
  try {
    budget.spendDay('xposedornot', 1);
    const res = await request(`https://api.xposedornot.com/v1/check-email/${encodeURIComponent(email)}`, {}, { timeoutMs: 15000, retries: 1 });
    const j = await res.json();
    // XposedOrNot returns { breaches: [[...]] } on hits, or a 404/"Not found" shape on none.
    const arr = Array.isArray(j?.breaches) ? j.breaches.flat().filter(Boolean) : [];
    return arr.length;
  } catch { return 0; }
}

function scoreGaps(sig) {
  let score = 0; const points = [];
  if (sig.hasDmarc === false) { score += 3; points.push('No DMARC record — domain spoofable (email security gap).'); }
  if (sig.hasSpf === false) { score += 1; points.push('No SPF record.'); }
  if ((sig.breachCount || 0) > 0) { score += Math.min(3, sig.breachCount); points.push(`${sig.breachCount} public breach(es) reference this domain.`); }
  if ((sig.subdomainCount || 0) > 5) { score += 2; points.push(`${sig.subdomainCount} subdomains exposed — external attack surface worth reviewing.`); }
  if (sig.mxProvider === 'microsoft365') points.push('Microsoft 365 tenant — M365 hardening / Hexnode MDM angle.');
  if ((sig.tech || []).length) points.push(`Tech: ${sig.tech.slice(0, 6).join(', ')}.`);
  return { gap_score: Math.min(10, score), talking_points: points.join(' ') };
}

async function enrichSecurity(domain, opts = {}) {
  const d = String(domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
  if (!d) return null;
  // opts.primaryEmail (a harvested role email like info@domain) drives the email-level breach check
  const [{ hasDmarc, hasSpf }, mx, subs, tech, breaches] = await Promise.all([
    dmarcSpf(d), mxProvider(d), subdomains(d, opts), techFingerprint(d, opts),
    breachCountForEmail(opts.primaryEmail, opts),
  ]);
  const sig = { hasDmarc, hasSpf, mxProvider: mx, subdomainCount: subs.length, tech, breachCount: breaches };
  const { gap_score, talking_points } = scoreGaps(sig);
  return { ...sig, gap_score, talking_points };
}

module.exports = { enrichSecurity, scoreGaps };
```

- [ ] **Step 4: Run → pass** — `cd leadgen && node --test test/osint.test.js` → PASS.

- [ ] **Step 5: Commit**
```bash
git add leadgen/lib/osint.js leadgen/test/osint.test.js
git commit -m "feat(leadgen): free OSINT security-signal enrichment (DNS/DMARC/subfinder/httpx/breach)"
```

---

### Task C5: `contacts.js` — extend scrape paths + return names/titles

**Files:**
- Modify: `leadgen/lib/contacts.js` (`CANDIDATE_PATHS` line 11–15; return shape)

**Interfaces:**
- Produces: `harvestContacts()` return gains `people: [{name,title}]` (raw text candidates); still returns `{emails, phones, best, source}`.

- [ ] **Step 1: Add the new paths**

In `leadgen/lib/contacts.js`, extend `CANDIDATE_PATHS` (lines 11–15) to add `/team`, `/leadership`, `/management`, `/careers`, `/about/team`:
```js
const CANDIDATE_PATHS = [
  '', '/contact', '/contact-us', '/contactus', '/contact.html',
  '/about', '/about-us', '/team', '/our-team', '/people',
  '/leadership', '/management', '/about/team', '/careers',
  '/impressum', '/support', '/get-in-touch',
];
```

- [ ] **Step 2: Extract candidate name/title strings from team-page HTML**

Add a helper and include `people` in the return. Insert near the other extractors:
```js
// crude name+title pairs from team/leadership markup (fed to Claude in enrich for structured parse)
function extractPeople(html) {
  const out = [];
  const re = /<(h[2-4]|strong|b)[^>]*>\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*<\/\1>\s*(?:<[^>]+>\s*)?([A-Z][A-Za-z0-9 &/,-]{2,40})?/g;
  let m;
  while ((m = re.exec(html)) && out.length < 20) {
    out.push({ name: m[2].trim(), title: (m[3] || '').trim() });
  }
  return out;
}
```
In `harvestContacts`, accumulate `people` across fetched pages and add to the returned object (return shape becomes `{ emails, phones, best, source, people }`).

- [ ] **Step 3: Verify against a known site (network; best-effort)**

Run:
```bash
cd leadgen && node -e "require('./lib/contacts.js').harvestContacts('https://underwings.org').then((r)=>console.log(JSON.stringify({emails:r.emails?.slice(0,3), people:r.people?.slice(0,3), source:r.source}))).catch((e)=>console.log('ERR',e.message))"
```
Expected: a JSON object with `emails` and possibly `people`; `source:'website-scrape'`. (Content varies; the check is that it runs and returns the extended shape without throwing.)

- [ ] **Step 4: Commit**
```bash
git add leadgen/lib/contacts.js
git commit -m "feat(leadgen): scrape team/leadership/careers + extract name/title candidates"
```

---

### Task C6: Wire enrichment + CRM sink into `run.js`; drop the Sheets path

**Files:**
- Modify: `leadgen/run.js` (imports; `runOnce` lines 115–176; remove sheet client + `toRow` write)
- Modify: `leadgen/config.js` (add `security`, `breach`, `emailVerify`, `people`, `supabase` config; `intervalMinutes`, `maxCandidatesPerRun`)

**Interfaces:**
- Consumes: `makeCrmClient` (C1), `enrichSecurity` (C4), `permuteEmails` (C3), daily budget (C2), extended `harvestContacts` (C5).
- Produces: a `runOnce()` that writes prospects + prospect_contacts to Supabase (no Google Sheets), skips suppressed emails, and sets 24h/50 cadence.

- [ ] **Step 1: Add config keys**

In `leadgen/config.js`, change `intervalMinutes: 360` → `1440` and keep `maxCandidatesPerRun: 50`. Add a sibling block before the closing `}`:
```js
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },
  security: { subfinder: true, dnsx: true, httpx: true, testssl: false, dnstwist: false, timeoutMs: 60000 },
  breach: { enabled: true, provider: 'xposedornot', breachDailyCap: 40 },
  emailVerify: { patternGuess: true },
  people: { teamPageScrape: true, difcAdgm: false, linkedinDork: false },
```

- [ ] **Step 2: Replace the Sheets wiring in `runOnce`**

In `leadgen/run.js`:
1. Add imports at top: `const { makeCrmClient } = require('./lib/crm.js'); const { enrichSecurity } = require('./lib/osint.js'); const { permuteEmails } = require('./lib/permute.js');`
2. Remove the `sheetsLib`/`getAccessToken`/`makeClient` usage (lines ~126–137) and the SA-key read. Replace with:
```js
  const crm = makeCrmClient(cfg.supabase.url, cfg.supabase.serviceKey);
  const suppressed = await crm.listSuppressed();
```
3. Remove the `startRow`/sheet-column dedupe reads; keep the in-memory `seen`-set dedupe (state/seen.json) as the dedupe source.
4. Replace the write block (lines ~168–170) with a per-lead upsert that also runs security enrichment + contact rows:
```js
  for (const lead of leads) {
    try {
      // security-signal enrichment (free) — pass the scraped role email for the email-level breach check
      if (lead.domain) {
        const sec = await enrichSecurity(lead.domain, { ...cfg.security, ...cfg.breach, primaryEmail: lead.email });
        if (sec) { lead.gap_score = sec.gap_score; lead.talking_points = sec.talking_points; }
      }
      const prospectId = await crm.upsertProspect(lead);
      // assemble contacts: scraped role email + guessed patterns (probable), Hunter person if present
      const contacts = [];
      if (lead.email && !suppressed.has(String(lead.email).toLowerCase())) {
        contacts.push({ name: lead.contactName, title: lead.target_title, email: lead.email, emailStatus: lead.emailStatus || 'role', phone: lead.phone, linkedin: lead.linkedin, source: lead.contactName ? 'hunter' : 'scrape', confidence: 60 });
      }
      if (cfg.emailVerify.patternGuess && lead.contactName && lead.domain) {
        for (const guess of permuteEmails(lead.contactName, lead.domain)) {
          if (!suppressed.has(guess)) contacts.push({ name: lead.contactName, title: lead.target_title, email: guess, emailStatus: 'probable', source: 'pattern', confidence: 30 });
        }
      }
      await crm.addProspectContacts(prospectId, contacts);
    } catch (e) { console.error('crm write failed for', lead.company, e.message); }
  }
```
5. Delete `toRow()` (lines 54–73) and the `enrichExisting()` sheet path (or repoint it later — out of scope; remove the `--enrich-existing` branch for now).

- [ ] **Step 3: Guard required env**

Near the top of `runOnce`, replace the SA-key requirement with:
```js
  if (!cfg.supabase.url || !cfg.supabase.serviceKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');
```

- [ ] **Step 4: Syntax-check + a dry run against the DB (no binaries needed for DNS path)**

Run:
```bash
cd leadgen && node -e "require('./run.js')" 2>&1 | head -5 || true   # module loads without throwing at import
```
Expected: no `SyntaxError`. (Full run needs env + binaries — validated in C7 after the Docker image exists.)

- [ ] **Step 5: Commit**
```bash
git add leadgen/run.js leadgen/config.js
git commit -m "feat(leadgen): write prospects to CRM + security enrichment; retire Google Sheets"
```

---

### Task C7: leadgen Dockerfile (Go binaries) + compose wiring

**Files:**
- Create: `leadgen/Dockerfile`
- Modify: `docker-compose.yml` (leadgen service: `build` instead of `image`; env; drop SA mount)
- Modify: `/home/deployer/underwings/.env` (add `SUPABASE_URL`; reuse `SERVICE_ROLE_KEY`)

**Interfaces:**
- Produces: a `leadgen` image with `subfinder`/`dnsx`/`httpx` on PATH and the CRM env wired.

- [ ] **Step 1: Create `leadgen/Dockerfile`**
```dockerfile
FROM golang:1.23 AS osint
RUN GOBIN=/out go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest \
 && GOBIN=/out go install github.com/projectdiscovery/dnsx/cmd/dnsx@latest \
 && GOBIN=/out go install github.com/projectdiscovery/httpx/cmd/httpx@latest

FROM node:20-slim
WORKDIR /app
COPY --from=osint /out/* /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . /app
USER node
CMD ["node", "run.js", "--loop"]
```

- [ ] **Step 2: Update the compose `leadgen` service**

In `docker-compose.yml` (lines ~399–417): replace `image: node:20-alpine` with `build: ./leadgen`; drop the `volumes:` SA-key mount and `GOOGLE_SA_KEY_PATH`; keep the `./leadgen:/app` bind only if you want live code (for a built image, drop it or keep for dev). Add env:
```yaml
      - SUPABASE_URL=${SUPABASE_URL:-http://kong:8000}
      - SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
```
Remove `- GOOGLE_PLACES...`? No — keep the optional source keys. Final env block keeps `ANTHROPIC_API_KEY`, `GOOGLE_PLACES_API_KEY`, `FIRECRAWL_API_KEY`, `HUNTER_API_KEY`, `KUMA_PUSH_URL`, plus the two new SUPABASE vars. Remove the Google SA volume line and `GOOGLE_SA_KEY_PATH`.

- [ ] **Step 3: Add `.env` var**

Ensure `/home/deployer/underwings/.env` has `SUPABASE_URL=http://kong:8000` (internal) and that `SERVICE_ROLE_KEY` already exists (it does — used by frontend). Do not commit `.env`.

- [ ] **Step 4: Build + one-shot run**

Run:
```bash
docker compose build leadgen
docker compose run --rm leadgen node run.js   # one cycle (no --loop)
```
Expected: logs show gather → score → per-lead CRM writes; no fatal error. Then verify rows landed:
```bash
docker exec -i underwings-db psql -U postgres -d underwings -c \
"SELECT count(*) AS prospects FROM crm_prospects; SELECT count(*) AS contacts FROM crm_prospect_contacts; SELECT company_name, ai_score, gap_score, left(talking_points,60) FROM crm_prospects ORDER BY created_at DESC LIMIT 5;"
```
Expected: non-zero prospects, some with `gap_score`/`talking_points` populated (from the DNS/DMARC path even if the Go binaries find nothing).

- [ ] **Step 5: Verify the binaries are present in the image**

Run: `docker compose run --rm leadgen sh -c "which subfinder dnsx httpx"`
Expected: three `/usr/local/bin/...` paths.

- [ ] **Step 6: Start the loop + commit**

```bash
docker compose up -d leadgen
git add leadgen/Dockerfile docker-compose.yml
git commit -m "feat(leadgen): Dockerfile with PD binaries; wire Supabase; drop Sheets SA mount"
```

**► Phase C ships here: every 24h up to 50 cold UAE companies are scored, security-enriched at $0, and written to the CRM prospects tab with talking points — one click from becoming pipeline.**

---

## Post-implementation

- [ ] Run the full leadgen test suite: `cd leadgen && node --test` → all pass.
- [ ] Hand-enter the ~45 warm founding targets via CRM → + New Deal (or a one-off SQL seed).
- [ ] Confirm `crm.underwings.org` → `/admin/` CRM in a real browser.
- [ ] Update memory [[project-crm-status]]: CRM is now live/custom; leadgen writes to CRM; Sheets retired.
