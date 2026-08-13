-- 022_vapt.sql — fourth prospect kind 'vapt' (UAE pen-testing buyer list)
--
-- The VAPT tab is a fourth track next to LeadGen (customer), Partners
-- (partner) and BLead (blead): UAE organisations that plausibly buy
-- penetration testing, produced by leadgen/generate-vapt.js (bulk one-shot,
-- Apollo-free) and by analyse-blead-vapt.js re-kinding qualifying BLead rows.
-- Same table, same filters, same column-grant split — kind stays
-- pipeline-owned (014 deliberately never granted UPDATE(kind) to
-- authenticated; unchanged here).
--
-- 014's kind constraint was created behind an IF-NOT-EXISTS guard on the
-- conname, so re-running 014 can never widen it — drop and re-add explicitly
-- (same dance as 020).

ALTER TABLE public.crm_prospects
    DROP CONSTRAINT IF EXISTS crm_prospects_kind_check;
ALTER TABLE public.crm_prospects
    ADD CONSTRAINT crm_prospects_kind_check
    CHECK (kind IN ('customer', 'partner', 'blead', 'vapt'));

-- Phones taken from a Google Places (Maps) business listing are neither
-- scraped from the company site nor imported from a user list: give them
-- their own source so provenance stays queryable (020 last widened this).
ALTER TABLE public.crm_prospect_contacts
    DROP CONSTRAINT IF EXISTS crm_prospect_contacts_source_check;
ALTER TABLE public.crm_prospect_contacts
    ADD CONSTRAINT crm_prospect_contacts_source_check
    CHECK (source IN ('scrape', 'hunter', 'apollo', 'pattern', 'search', 'import', 'places'));

-- v_crm_leadgen_stats already GROUPs BY kind (014) — a 'vapt' row appears
-- automatically once at least one non-suppressed vapt prospect exists.

NOTIFY pgrst, 'reload schema';
