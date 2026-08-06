-- ===========================================
-- MIGRATION 011: LeadGen module.
--
-- Turns crm_prospects into the sink for the lead-generation pipeline (which
-- until now wrote to a Google Sheet and left this table empty) and adds the
-- supporting state the pipeline and the CRM LeadGen view need:
--   * enrichment columns on crm_prospects
--   * a column-level privilege split so sales owns status/notes and the
--     pipeline owns every enrichment column
--   * crm_leadgen_settings / _usage / _runs
--   * crm_leadgen_spend()  — atomic per-API-key monthly budget counter
--   * crm_leadgen_request_run() — admin "run a cycle now" trigger
--   * crm_prospect_promote() — atomic promote (replaces the SPA's two-step)
--   * v_crm_leadgen_stats — server-side stat tiles
-- Idempotent.
-- ===========================================

-- ---------- 1. enrichment columns on crm_prospects ----------
ALTER TABLE public.crm_prospects
    ADD COLUMN IF NOT EXISTS service      TEXT,          -- Underwings service line that fits
    ADD COLUMN IF NOT EXISTS why          TEXT,          -- Claude's one-line rationale
    ADD COLUMN IF NOT EXISTS country      TEXT,
    ADD COLUMN IF NOT EXISTS geo_bucket   TEXT,
    ADD COLUMN IF NOT EXISTS signal       TEXT,          -- the news/search snippet that surfaced it
    ADD COLUMN IF NOT EXISTS verified_at  TIMESTAMPTZ,   -- last successful email verification
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;   -- last cycle a source re-surfaced it

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'crm_prospects_geo_bucket_check'
                      AND conrelid = 'public.crm_prospects'::regclass) THEN
        ALTER TABLE public.crm_prospects
            ADD CONSTRAINT crm_prospects_geo_bucket_check
            CHECK (geo_bucket IS NULL OR geo_bucket IN ('uae','gcc','global'));
    END IF;
END $$;

-- Widen the sales lifecycle. 006 shipped new/enriched/contacted/promoted/
-- suppressed; sales also needs replied / qualified / disqualified so the
-- LeadGen view can express a real working funnel without inventing a
-- second status column.
ALTER TABLE public.crm_prospects DROP CONSTRAINT IF EXISTS crm_prospects_status_check;
ALTER TABLE public.crm_prospects
    ADD CONSTRAINT crm_prospects_status_check
    CHECK (status IN ('new','enriched','contacted','replied','qualified',
                      'disqualified','promoted','suppressed'));

CREATE INDEX IF NOT EXISTS idx_crm_prospects_service ON public.crm_prospects(service);
CREATE INDEX IF NOT EXISTS idx_crm_prospects_geo     ON public.crm_prospects(geo_bucket);
-- drives the "stale enough to re-verify" scan in the pipeline's refresh pass
CREATE INDEX IF NOT EXISTS idx_crm_prospects_verified ON public.crm_prospects(verified_at NULLS FIRST);

-- ---------- 2. the sales / enrichment privilege split ----------
-- The AKL pipeline enforced this in JS (store.js SALES_FIELDS vs
-- ENRICHMENT_FIELDS). Postgres does it properly: a browser session may write
-- exactly two columns, and no more. The pipeline authenticates as service_role,
-- which keeps full table UPDATE, so it owns every enrichment column and can
-- never clobber a human's notes. RLS (is_crm_user() AND aal2, migration 008)
-- still applies on top of these grants.
REVOKE UPDATE ON public.crm_prospects FROM authenticated;
GRANT  UPDATE (status, notes) ON public.crm_prospects TO authenticated;

-- crm_prospect_contacts is pipeline-owned outright; the SPA only reads it.
REVOKE UPDATE, INSERT ON public.crm_prospect_contacts FROM authenticated;

-- ---------- 3. crm_leadgen_settings (one row) ----------
-- Targeting lives here rather than only in config.js so the phase-2 targeting
-- editor has somewhere to write. V1 uses run_requested_at only; the pipeline
-- treats NULL columns as "fall back to config.js".
CREATE TABLE IF NOT EXISTS public.crm_leadgen_settings (
    id               BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),  -- single-row guard
    icp_description  TEXT,
    services         TEXT[],
    sectors          TEXT[],
    score_threshold  INT,
    interval_minutes INT,
    caps             JSONB   NOT NULL DEFAULT '{}'::jsonb,
    run_requested_at TIMESTAMPTZ,
    run_started_at   TIMESTAMPTZ,
    updated_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO public.crm_leadgen_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- ---------- 4. crm_leadgen_usage (per-API-key monthly budget) ----------
-- Replaces AKL's state/usage.json, which counted per checkout directory. Two
-- projects sharing one API key each spent up to their own cap and blew through
-- the real plan at 2x. key_ref is a short hash of the key, never the key.
CREATE TABLE IF NOT EXISTS public.crm_leadgen_usage (
    key_ref TEXT NOT NULL,
    month   TEXT NOT NULL,              -- 'YYYY-MM'
    source  TEXT NOT NULL,              -- 'firecrawl' | 'hunter-search' | ...
    count   INT  NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (key_ref, month, source)
);

-- ---------- 5. crm_leadgen_runs (cycle log) ----------
CREATE TABLE IF NOT EXISTS public.crm_leadgen_runs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle       INT,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    candidates  INT NOT NULL DEFAULT 0,   -- surfaced by sources, after dedupe
    scored      INT NOT NULL DEFAULT 0,   -- returned by Claude
    kept        INT NOT NULL DEFAULT 0,   -- at or above the score threshold
    added       INT NOT NULL DEFAULT 0,   -- new rows in crm_prospects
    ok          BOOLEAN NOT NULL DEFAULT FALSE,
    -- not "trigger": that is a reserved word and would need quoting forever
    triggered_by TEXT NOT NULL DEFAULT 'schedule' CHECK (triggered_by IN ('schedule','manual')),
    errors      JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_crm_leadgen_runs_started ON public.crm_leadgen_runs(started_at DESC);

-- ---------- 6. RLS on the three new tables ----------
-- Read-only for CRM users at aal2, matching every other crm_* table; writes
-- are service_role (pipeline) or the SECURITY DEFINER RPCs below.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_leadgen_settings','crm_leadgen_usage','crm_leadgen_runs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS "crm read" ON public.%I;', t);
    EXECUTE format($f$CREATE POLICY "crm read" ON public.%I FOR SELECT USING (public.is_crm_user() AND (auth.jwt()->>'aal') = 'aal2');$f$, t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated;', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM authenticated, anon;', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon;', t);
  END LOOP;
END $$;

-- ---------- 7. crm_leadgen_spend(): atomic monthly budget counter ----------
-- Returns the NEW running total for (key_ref, month, source). The pipeline
-- spends before it calls, so a failed API call still burns the counter —
-- deliberate: over-counting is cheaper than over-spending.
CREATE OR REPLACE FUNCTION public.crm_leadgen_spend(
    p_key_ref TEXT, p_month TEXT, p_source TEXT, p_n INT DEFAULT 1)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_total INT;
BEGIN
    IF COALESCE(auth.jwt()->>'role', '') <> 'service_role' THEN
        RAISE EXCEPTION 'crm_leadgen_spend: service_role only';
    END IF;
    INSERT INTO public.crm_leadgen_usage (key_ref, month, source, count)
    VALUES (p_key_ref, p_month, p_source, GREATEST(p_n, 0))
    ON CONFLICT (key_ref, month, source) DO UPDATE
        SET count = crm_leadgen_usage.count + GREATEST(p_n, 0),
            updated_at = NOW()
    RETURNING crm_leadgen_usage.count INTO v_total;
    RETURN v_total;
END;
$$;
REVOKE ALL ON FUNCTION public.crm_leadgen_spend(TEXT, TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_leadgen_spend(TEXT, TEXT, TEXT, INT) TO service_role;

-- ---------- 8. crm_leadgen_request_run(): admin "run now" ----------
-- The browser cannot reach the leadgen container (CSP connect-src 'self', and
-- there is no route to it), so "run now" is a flag the pipeline polls between
-- cycles. Rate-limited to one pending request per 2 minutes so a double-click
-- can't queue a stampede.
CREATE OR REPLACE FUNCTION public.crm_leadgen_request_run()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_prev TIMESTAMPTZ;
BEGIN
    IF NOT (public.is_crm_admin() AND (auth.jwt()->>'aal') = 'aal2') THEN
        RAISE EXCEPTION 'crm_leadgen_request_run: not authorized';
    END IF;
    SELECT run_requested_at INTO v_prev FROM public.crm_leadgen_settings WHERE id;
    IF v_prev IS NOT NULL AND v_prev > NOW() - INTERVAL '2 minutes' THEN
        RETURN jsonb_build_object('queued', false, 'requested_at', v_prev,
                                  'reason', 'a run is already queued');
    END IF;
    UPDATE public.crm_leadgen_settings
       SET run_requested_at = NOW(), updated_by = auth.uid(), updated_at = NOW()
     WHERE id;
    RETURN jsonb_build_object('queued', true, 'requested_at', NOW());
END;
$$;
REVOKE ALL ON FUNCTION public.crm_leadgen_request_run() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_leadgen_request_run() TO authenticated, service_role;

-- ---------- 9. crm_prospect_promote(): atomic promote ----------
-- The SPA used to call crm_intake and then UPDATE the prospect in a second,
-- unchecked round trip — a failure there left a deal with no back-link and a
-- prospect that still looked unpromoted. Both writes now happen in one
-- transaction, and the prospect's best contact is picked server-side.
CREATE OR REPLACE FUNCTION public.crm_prospect_promote(p_prospect_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    p        public.crm_prospects%ROWTYPE;
    c        public.crm_prospect_contacts%ROWTYPE;
    v_seg    TEXT;
    v_res    JSONB;
    v_deal   UUID;
BEGIN
    IF NOT (public.is_crm_user() AND (auth.jwt()->>'aal') = 'aal2') THEN
        RAISE EXCEPTION 'crm_prospect_promote: not authorized';
    END IF;

    SELECT * INTO p FROM public.crm_prospects WHERE id = p_prospect_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'crm_prospect_promote: no such prospect'; END IF;

    -- best known person for this company; NULL row is fine (company-only deal)
    SELECT * INTO c FROM public.crm_prospect_contacts
     WHERE prospect_id = p_prospect_id
     ORDER BY confidence DESC NULLS LAST, created_at LIMIT 1;

    -- crm_deals.icp_segment is a 4-value enum, narrower than our service lines
    v_seg := CASE
        WHEN p.industry ILIKE '%health%' OR p.industry ILIKE '%medical%'
          OR p.industry ILIKE '%clinic%' OR p.industry ILIKE '%hospital%' THEN 'healthcare'
        WHEN p.service ILIKE '%ISO%' OR p.service ILIKE '%GRC%'            THEN 'iso'
        WHEN p.service ILIKE '%PDPL%' OR p.service ILIKE '%privacy%'       THEN 'pdpl'
        ELSE 'other' END;

    v_res := public.crm_intake(jsonb_build_object(
        'company_name',  p.company_name,
        'domain',        p.domain,
        'website',       p.website,
        'industry',      p.industry,
        'emirate',       p.emirate,
        'email',         c.email,
        'contact_name',  c.name,
        'job_title',     c.job_title,
        'phone',         c.phone,
        'title',         p.company_name,
        'description',   p.talking_points,
        'motion',        'services',
        'stage',         'new',
        'source',        'leadgen',
        'icp_segment',   v_seg,
        'ai_score',      p.ai_score,
        -- double-promote is a no-op: crm_intake short-circuits on external_ref
        'external_ref',  'prospect:' || p.id::text,
        'activity_note', 'Promoted from LeadGen signal (' || COALESCE(p.source, 'leadgen') || ').'
    ));

    v_deal := (v_res->>'deal_id')::UUID;
    UPDATE public.crm_prospects
       SET status = 'promoted', promoted_deal_id = v_deal, updated_at = NOW()
     WHERE id = p_prospect_id;

    RETURN v_res || jsonb_build_object('prospect_id', p_prospect_id);
END;
$$;
REVOKE ALL ON FUNCTION public.crm_prospect_promote(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_prospect_promote(UUID) TO authenticated, service_role;

-- ---------- 10. v_crm_leadgen_stats ----------
-- One row. security_invoker so the caller's RLS applies (anon sees nothing),
-- matching v_crm_stage_totals in migration 010.
CREATE OR REPLACE VIEW public.v_crm_leadgen_stats
    WITH (security_invoker=true) AS
WITH p AS (
    SELECT pr.*,
           EXISTS (SELECT 1 FROM public.crm_prospect_contacts pc
                    WHERE pc.prospect_id = pr.id AND nullif(btrim(pc.name), '') IS NOT NULL)
             AS has_named_contact,
           EXISTS (SELECT 1 FROM public.crm_prospect_contacts pc
                    WHERE pc.prospect_id = pr.id AND pc.email_status = 'verified')
             AS has_verified_email,
           EXISTS (SELECT 1 FROM public.crm_prospect_contacts pc
                    WHERE pc.prospect_id = pr.id AND nullif(btrim(pc.email), '') IS NOT NULL)
             AS has_email
      FROM public.crm_prospects pr
     WHERE pr.status <> 'suppressed'
),
agg AS (
    SELECT
        count(*)::INT                                             AS total,
        count(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::INT AS added_7d,
        count(*) FILTER (WHERE has_email)::INT                    AS with_email,
        count(*) FILTER (WHERE has_named_contact)::INT            AS named_contacts,
        count(*) FILTER (WHERE has_verified_email)::INT           AS verified_emails,
        count(*) FILTER (WHERE status = 'promoted')::INT          AS promoted,
        ROUND(AVG(ai_score) FILTER (WHERE ai_score IS NOT NULL), 1) AS avg_score
      FROM p
),
by_status AS (
    SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) AS by_status
      FROM (SELECT status, count(*)::INT AS n FROM p GROUP BY status) z
),
by_service AS (
    SELECT COALESCE(jsonb_object_agg(service, n), '{}'::jsonb) AS by_service
      FROM (SELECT COALESCE(nullif(btrim(service), ''), 'Unclassified') AS service,
                   count(*)::INT AS n FROM p GROUP BY 1) z
),
by_geo AS (
    SELECT COALESCE(jsonb_object_agg(geo_bucket, n), '{}'::jsonb) AS by_geo
      FROM (SELECT COALESCE(geo_bucket, 'unknown') AS geo_bucket,
                   count(*)::INT AS n FROM p GROUP BY 1) z
),
last_run AS (
    SELECT started_at AS last_run_at, ok AS last_run_ok, added AS last_run_added,
           triggered_by AS last_run_trigger
      FROM public.crm_leadgen_runs ORDER BY started_at DESC LIMIT 1
)
SELECT agg.*, by_status.by_status, by_service.by_service, by_geo.by_geo,
       last_run.last_run_at, last_run.last_run_ok,
       last_run.last_run_added, last_run.last_run_trigger
  FROM agg
  CROSS JOIN by_status CROSS JOIN by_service CROSS JOIN by_geo
  LEFT JOIN last_run ON TRUE;

GRANT SELECT ON public.v_crm_leadgen_stats TO authenticated, service_role;

-- ---------- 11. PostgREST schema cache ----------
-- New functions and views 404 through the API until the cache is reloaded.
NOTIFY pgrst, 'reload schema';
