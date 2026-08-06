-- 013_outreach_drafts.sql — per-prospect cold-email drafts.
--
-- The pipeline (service_role) writes an AI-drafted, hook-led subject + body
-- when a prospect is created (or backfills one where missing). From then on
-- the draft is SALES-OWNED, exactly like status/notes: sales edit it in the
-- CRM drawer, save, copy, and send from their own mailbox. The pipeline only
-- ever fills a NULL draft (store-pg's setOutreachDraft filters on
-- outreach_subject IS NULL), so a human edit is never overwritten.

BEGIN;

ALTER TABLE public.crm_prospects
  ADD COLUMN IF NOT EXISTS outreach_subject TEXT,
  ADD COLUMN IF NOT EXISTS outreach_body    TEXT;

-- Column grants are additive: 011 granted (status, notes); this extends the
-- sales-writable set. RLS (is_crm_user() AND aal2) still applies on top.
GRANT UPDATE (outreach_subject, outreach_body)
  ON public.crm_prospects TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
