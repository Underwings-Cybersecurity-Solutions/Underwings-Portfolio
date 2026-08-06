-- ===========================================
-- MIGRATION 010: CRM intake RPC + data-layer fixes
--   1. crm_deals.last_activity_at (+ trigger + backfill) — one source of truth
--      for staleness, so the JS badge and v_crm_stale_deals stop disagreeing.
--   2. v_crm_stage_totals — server-side per-stage totals so the pipeline strip
--      is correct beyond the client's 500-row page.
--   3. subscribers readable by CRM users — v_crm_contact_signals.is_subscriber
--      was always false (subscribers RLS wanted admin_users; CRM users live in
--      crm_users and the two sets do not overlap).
--   4. crm_intake(jsonb) — atomic company+contact+deal upsert. Used by the
--      website form handlers (service_role) AND the SPA (authenticated+aal2),
--      so both stop creating duplicate companies via read-then-insert.
--   Idempotent; safe to re-run.
-- ===========================================

-- ---------- 1. last_activity_at ----------
ALTER TABLE public.crm_deals ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_crm_deals_last_activity ON public.crm_deals(last_activity_at);

-- backfill from the activity feed, falling back to updated_at
UPDATE public.crm_deals d
   SET last_activity_at = COALESCE(
         (SELECT max(a.occurred_at) FROM public.crm_activities a WHERE a.deal_id = d.id),
         d.updated_at)
 WHERE d.last_activity_at IS NULL;

-- keep it current: any activity row bumps its deal.
-- Safe against recursion — this UPDATE only re-fires crm_deals_log_stage, whose
-- WHEN (OLD.stage IS DISTINCT FROM NEW.stage) is false here, so it terminates.
CREATE OR REPLACE FUNCTION public.crm_touch_last_activity()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE public.crm_deals
       SET last_activity_at = NEW.occurred_at
     WHERE id = NEW.deal_id
       AND (last_activity_at IS NULL OR last_activity_at < NEW.occurred_at);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS crm_activities_touch_deal ON public.crm_activities;
CREATE TRIGGER crm_activities_touch_deal AFTER INSERT ON public.crm_activities
    FOR EACH ROW WHEN (NEW.deal_id IS NOT NULL)
    EXECUTE FUNCTION public.crm_touch_last_activity();

-- new deals start "active" so they don't read as stale before first contact
ALTER TABLE public.crm_deals ALTER COLUMN last_activity_at SET DEFAULT NOW();

-- ---------- 1b. stale view now reads the column ----------
-- DROP first: the view is SELECT d.*, and adding last_activity_at to the table
-- shifts its column list, which CREATE OR REPLACE VIEW refuses to do.
DROP VIEW IF EXISTS public.v_crm_stale_deals;
CREATE OR REPLACE VIEW public.v_crm_stale_deals
    WITH (security_invoker=true) AS
SELECT d.*,
       COALESCE(d.last_activity_at, d.updated_at) AS last_activity,
       CASE WHEN d.motion = 'services' THEN 30 ELSE 21 END AS stale_after_days
FROM public.crm_deals d
WHERE d.status = 'open'
  AND COALESCE(d.last_activity_at, d.updated_at) <
      NOW() - (CASE WHEN d.motion = 'services' THEN INTERVAL '30 days' ELSE INTERVAL '21 days' END);

-- ---------- 2. server-side stage totals (all deals, not just the loaded page) ----------
CREATE OR REPLACE VIEW public.v_crm_stage_totals
    WITH (security_invoker=true) AS
SELECT motion, stage,
       count(*)                    AS deal_count,
       COALESCE(sum(value_aed), 0) AS value_aed
FROM public.crm_deals
GROUP BY motion, stage;

GRANT SELECT ON public.v_crm_stage_totals TO anon, authenticated, service_role;

-- ---------- 3. let CRM users resolve newsletter signals ----------
-- v_crm_contact_signals is security_invoker, so the caller needs SELECT on
-- subscribers. CRM users are not admin_users, so is_subscriber was hardcoded
-- false in practice. Read-only, aal2-gated — mirrors the crm_* table policies.
DROP POLICY IF EXISTS "crm users read subscribers" ON public.subscribers;
CREATE POLICY "crm users read subscribers" ON public.subscribers
    FOR SELECT USING (public.is_crm_user() AND (auth.jwt()->>'aal') = 'aal2');

-- ---------- 4. crm_intake(): atomic company + contact + deal ----------
-- Replaces the SPA's read-then-insert helpers (which duplicated companies when
-- no domain was supplied, and raised 23505 on a concurrent same-domain insert)
-- and gives the website forms a single write path.
--
-- payload keys (all optional unless noted):
--   company_name, domain, website, industry, emirate
--   email, contact_name, phone, job_title
--   title (required-ish; defaults from company), description, motion, stage,
--   source, value_aed, icp_segment, ai_score, owner_id, next_action,
--   external_ref (idempotency key), activity_note
CREATE OR REPLACE FUNCTION public.crm_intake(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role        TEXT := COALESCE(auth.jwt()->>'role', '');
    v_email       TEXT := lower(nullif(btrim(payload->>'email'), ''));
    v_domain      TEXT := lower(nullif(btrim(payload->>'domain'), ''));
    v_company     TEXT := nullif(btrim(payload->>'company_name'), '');
    v_ext         TEXT := nullif(btrim(payload->>'external_ref'), '');
    v_motion      TEXT := COALESCE(nullif(btrim(payload->>'motion'), ''), 'services');
    v_stage       TEXT := COALESCE(nullif(btrim(payload->>'stage'), ''), 'new');
    v_source      TEXT := COALESCE(nullif(btrim(payload->>'source'), ''), 'other');
    v_title       TEXT := nullif(btrim(payload->>'title'), '');
    v_note        TEXT := nullif(btrim(payload->>'activity_note'), '');
    -- contact_only: register the person/company but open no deal. Used by
    -- newsletter signups, which are a signal (v_crm_contact_signals), not a deal.
    v_contact_only BOOLEAN := COALESCE((payload->>'contact_only')::BOOLEAN, false);
    v_company_id  UUID;
    v_contact_id  UUID;
    v_deal_id     UUID;
BEGIN
    -- authz: service_role writes freely (server-side form handlers); a browser
    -- session must be a CRM user at aal2, matching the crm_* table policies.
    IF v_role <> 'service_role' THEN
        IF NOT (public.is_crm_user() AND (auth.jwt()->>'aal') = 'aal2') THEN
            RAISE EXCEPTION 'crm_intake: not authorized';
        END IF;
    END IF;

    -- idempotency: same external_ref => return the existing deal untouched
    IF v_ext IS NOT NULL THEN
        SELECT id INTO v_deal_id FROM public.crm_deals WHERE external_ref = v_ext;
        IF v_deal_id IS NOT NULL THEN
            RETURN jsonb_build_object('deal_id', v_deal_id, 'created', false);
        END IF;
    END IF;

    -- derive a company domain from the contact email when none was supplied,
    -- skipping the usual free-mail providers so we don't merge unrelated leads.
    IF v_domain IS NULL AND v_email IS NOT NULL AND position('@' IN v_email) > 0 THEN
        v_domain := split_part(v_email, '@', 2);
        IF v_domain IN ('gmail.com','googlemail.com','yahoo.com','hotmail.com',
                        'outlook.com','live.com','icloud.com','me.com','aol.com',
                        'proton.me','protonmail.com','yandex.com','mail.com') THEN
            v_domain := NULL;
        END IF;
    END IF;

    -- ---- company ----
    IF v_domain IS NOT NULL THEN
        SELECT id INTO v_company_id FROM public.crm_companies WHERE lower(domain) = v_domain;
    ELSIF v_company IS NOT NULL THEN
        -- no domain to key on: match on name so repeat submissions from the same
        -- company don't fan out into duplicate rows (the old SPA bug)
        SELECT id INTO v_company_id FROM public.crm_companies
         WHERE lower(name) = lower(v_company) ORDER BY created_at LIMIT 1;
    END IF;

    IF v_company_id IS NULL AND (v_company IS NOT NULL OR v_domain IS NOT NULL) THEN
        INSERT INTO public.crm_companies (name, domain, website, industry, emirate)
        VALUES (COALESCE(v_company, v_domain),
                v_domain,
                nullif(btrim(payload->>'website'), ''),
                nullif(btrim(payload->>'industry'), ''),
                nullif(btrim(payload->>'emirate'), ''))
        ON CONFLICT (lower(domain)) WHERE domain IS NOT NULL DO NOTHING
        RETURNING id INTO v_company_id;

        -- lost the race: another transaction inserted the same domain first
        IF v_company_id IS NULL AND v_domain IS NOT NULL THEN
            SELECT id INTO v_company_id FROM public.crm_companies WHERE lower(domain) = v_domain;
        END IF;
    END IF;

    -- ---- contact ----
    IF v_email IS NOT NULL THEN
        INSERT INTO public.crm_contacts (email, name, company_id, phone, job_title)
        VALUES (v_email,
                nullif(btrim(payload->>'contact_name'), ''),
                v_company_id,
                nullif(btrim(payload->>'phone'), ''),
                nullif(btrim(payload->>'job_title'), ''))
        ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO NOTHING
        RETURNING id INTO v_contact_id;

        IF v_contact_id IS NULL THEN
            SELECT id INTO v_contact_id FROM public.crm_contacts WHERE lower(email) = v_email;
            -- enrich blanks only; never overwrite what a human curated
            UPDATE public.crm_contacts
               SET name       = COALESCE(name, nullif(btrim(payload->>'contact_name'), '')),
                   phone      = COALESCE(phone, nullif(btrim(payload->>'phone'), '')),
                   job_title  = COALESCE(job_title, nullif(btrim(payload->>'job_title'), '')),
                   company_id = COALESCE(company_id, v_company_id)
             WHERE id = v_contact_id;
        END IF;
    END IF;

    IF v_contact_only THEN
        RETURN jsonb_build_object(
            'company_id', v_company_id, 'contact_id', v_contact_id,
            'created', false, 'contact_only', true);
    END IF;

    -- ---- deal ----
    INSERT INTO public.crm_deals (
        title, description, motion, stage, value_aed, company_id, contact_id,
        source, icp_segment, ai_score, owner_id, next_action, external_ref
    ) VALUES (
        COALESCE(v_title, COALESCE(v_company, v_email, 'Inbound enquiry')),
        nullif(btrim(payload->>'description'), ''),
        v_motion,
        v_stage,
        (payload->>'value_aed')::NUMERIC,
        v_company_id,
        v_contact_id,
        v_source,
        nullif(btrim(payload->>'icp_segment'), ''),
        (payload->>'ai_score')::INT,
        (payload->>'owner_id')::UUID,
        nullif(btrim(payload->>'next_action'), ''),
        v_ext
    )
    RETURNING id INTO v_deal_id;

    IF v_note IS NOT NULL THEN
        INSERT INTO public.crm_activities (deal_id, type, body, actor_id)
        VALUES (v_deal_id, 'system', v_note, auth.uid());
    END IF;

    RETURN jsonb_build_object(
        'deal_id', v_deal_id, 'company_id', v_company_id,
        'contact_id', v_contact_id, 'created', true);
END;
$$;

REVOKE ALL ON FUNCTION public.crm_intake(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_intake(JSONB) TO authenticated, service_role;
