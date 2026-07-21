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
