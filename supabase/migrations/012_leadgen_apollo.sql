-- ===========================================
-- MIGRATION 012: LeadGen contact enrichment moved from Hunter.io to Apollo.io.
-- crm_prospect_contacts.source needs the new value; 'hunter' stays valid so
-- existing rows keep passing the CHECK. Idempotent.
-- ===========================================
ALTER TABLE public.crm_prospect_contacts
    DROP CONSTRAINT IF EXISTS crm_prospect_contacts_source_check;
ALTER TABLE public.crm_prospect_contacts
    ADD CONSTRAINT crm_prospect_contacts_source_check
    CHECK (source IN ('scrape', 'hunter', 'apollo', 'pattern', 'search'));

NOTIFY pgrst, 'reload schema';
