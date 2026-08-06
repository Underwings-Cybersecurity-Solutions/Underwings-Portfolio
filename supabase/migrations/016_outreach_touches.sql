-- 016_outreach_touches.sql — per-prospect outreach checkboxes.
--
-- The LeadGen table used to carry a `status` dropdown with eight lifecycle
-- values. For a small sales team that is a quiz: nobody agrees what
-- "qualified" means, so the field goes stale and the funnel data lies. What
-- the team actually needs to see at a glance is "have I tried this company,
-- and how" — so the row now shows four checkboxes (call / message /
-- LinkedIn / follow-up), then notes, then Promote.
--
-- `status` stays in the schema: it is what the toolbar filter and the
-- promote flow use. The UI now maintains it for the team — ticking the first
-- box moves a 'new' row to 'contacted'.
--
-- These are SALES-owned, like status/notes/outreach_* (migrations 011, 013).

BEGIN;

ALTER TABLE public.crm_prospects
    ADD COLUMN IF NOT EXISTS touch_call   BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS touch_msg    BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS touch_li     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS touch_follow BOOLEAN NOT NULL DEFAULT FALSE;

GRANT UPDATE (touch_call, touch_msg, touch_li, touch_follow)
  ON public.crm_prospects TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
