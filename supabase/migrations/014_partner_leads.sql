-- 014_partner_leads.sql — collaboration/partner lead track.
--
-- The scorer used to DROP security vendors, MSSPs, integrators and audit
-- firms as "competitors, not buyers". They are exactly who Underwings can
-- partner with (referrals, white-label pen testing, audit support), so the
-- pipeline now classifies every kept lead as kind='customer' or
-- kind='partner' and the CRM shows partners in their own tab beside LeadGen.
--
-- kind is an ENRICHMENT column: the pipeline owns it, sales cannot change it
-- (the 011 REVOKE already covers any column not explicitly granted).

BEGIN;

ALTER TABLE public.crm_prospects
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'customer';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'crm_prospects_kind_check'
                      AND conrelid = 'public.crm_prospects'::regclass) THEN
        ALTER TABLE public.crm_prospects
            ADD CONSTRAINT crm_prospects_kind_check
            CHECK (kind IN ('customer','partner'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_prospects_kind ON public.crm_prospects(kind);

-- ---------- stats view: one row PER KIND ----------
-- Output columns change (new leading `kind`), so REPLACE is not enough.
DROP VIEW IF EXISTS public.v_crm_leadgen_stats;

CREATE VIEW public.v_crm_leadgen_stats
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
        kind,
        count(*)::INT                                             AS total,
        count(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::INT AS added_7d,
        count(*) FILTER (WHERE has_email)::INT                    AS with_email,
        count(*) FILTER (WHERE has_named_contact)::INT            AS named_contacts,
        count(*) FILTER (WHERE has_verified_email)::INT           AS verified_emails,
        count(*) FILTER (WHERE status = 'promoted')::INT          AS promoted,
        ROUND(AVG(ai_score) FILTER (WHERE ai_score IS NOT NULL), 1) AS avg_score
      FROM p
     GROUP BY kind
),
by_status AS (
    SELECT kind, COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) AS by_status
      FROM (SELECT kind, status, count(*)::INT AS n FROM p GROUP BY kind, status) z
     GROUP BY kind
),
by_service AS (
    SELECT kind, COALESCE(jsonb_object_agg(service, n), '{}'::jsonb) AS by_service
      FROM (SELECT kind, COALESCE(nullif(btrim(service), ''), 'Unclassified') AS service,
                   count(*)::INT AS n FROM p GROUP BY 1, 2) z
     GROUP BY kind
),
by_geo AS (
    SELECT kind, COALESCE(jsonb_object_agg(geo_bucket, n), '{}'::jsonb) AS by_geo
      FROM (SELECT kind, COALESCE(geo_bucket, 'unknown') AS geo_bucket,
                   count(*)::INT AS n FROM p GROUP BY 1, 2) z
     GROUP BY kind
),
last_run AS (
    SELECT started_at AS last_run_at, ok AS last_run_ok, added AS last_run_added,
           triggered_by AS last_run_trigger
      FROM public.crm_leadgen_runs ORDER BY started_at DESC LIMIT 1
)
SELECT agg.*, bs.by_status, sv.by_service, geo.by_geo,
       last_run.last_run_at, last_run.last_run_ok,
       last_run.last_run_added, last_run.last_run_trigger
  FROM agg
  JOIN by_status bs USING (kind)
  JOIN by_service sv USING (kind)
  JOIN by_geo geo USING (kind)
  LEFT JOIN last_run ON TRUE;

GRANT SELECT ON public.v_crm_leadgen_stats TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
