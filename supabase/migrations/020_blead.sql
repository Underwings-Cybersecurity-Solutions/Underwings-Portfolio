-- 020_blead.sql — third prospect kind 'blead' (bulk-imported outbound list)
--
-- The BLead tab in the CRM is a third track next to LeadGen (customer) and
-- Partners (partner): companies bulk-imported from user-supplied lists by
-- leadgen/import-blead.js rather than discovered by the pipeline. Same table,
-- same filters, same column-grant split — kind stays pipeline-owned (014
-- deliberately never granted UPDATE(kind) to authenticated; unchanged here).
--
-- 014's kind constraint was created behind an IF-NOT-EXISTS guard on the
-- conname, so re-running 014 can never widen it — drop and re-add explicitly.

ALTER TABLE public.crm_prospects
    DROP CONSTRAINT IF EXISTS crm_prospects_kind_check;
ALTER TABLE public.crm_prospects
    ADD CONSTRAINT crm_prospects_kind_check
    CHECK (kind IN ('customer', 'partner', 'blead'));

-- Contacts carried by an import are neither scraped nor searched: give them
-- their own source so provenance stays queryable (012 last widened this).
ALTER TABLE public.crm_prospect_contacts
    DROP CONSTRAINT IF EXISTS crm_prospect_contacts_source_check;
ALTER TABLE public.crm_prospect_contacts
    ADD CONSTRAINT crm_prospect_contacts_source_check
    CHECK (source IN ('scrape', 'hunter', 'apollo', 'pattern', 'search', 'import'));

-- v_crm_leadgen_stats already GROUPs BY kind (014) — a 'blead' row appears
-- automatically once at least one non-suppressed blead prospect exists.

NOTIFY pgrst, 'reload schema';
