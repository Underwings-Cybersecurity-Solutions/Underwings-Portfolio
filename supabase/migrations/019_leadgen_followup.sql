-- 019_leadgen_followup.sql — company LinkedIn + follow-up timing.
--
-- Two gaps this closes:
--
--   1. Apollo org enrichment returns the COMPANY LinkedIn page and the
--      pipeline used to throw it away. When people-search finds no named
--      person, that page is where a human goes to find one manually — so it
--      belongs on the prospect row (a person's LinkedIn stays on the
--      crm_prospect_contacts row, as before).
--
--   2. 148 prospects were cold-emailed and not one ever got a follow-up:
--      the touch_* boxes record THAT a channel was used, never WHEN. A
--      follow-up queue needs a date, so `last_outreach_at` stamps itself
--      (trigger below) whenever a touch box is first ticked. The CRM may
--      also set it directly (granted) so repeat follow-ups — where the box
--      is already ticked — still move the clock forward.
--
-- Backfill uses updated_at: for the already-mailed rows the touch tick was
-- effectively the last write, so it is the closest thing to a send date we
-- have. Slightly stale beats NULL, which would hide all 148 from the queue.

BEGIN;

ALTER TABLE public.crm_prospects
    ADD COLUMN IF NOT EXISTS linkedin_url     TEXT,
    ADD COLUMN IF NOT EXISTS last_outreach_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.crm_prospects_stamp_outreach()
RETURNS TRIGGER AS $$
BEGIN
    IF (NEW.touch_call   AND NOT OLD.touch_call)  OR
       (NEW.touch_mail   AND NOT OLD.touch_mail)  OR
       (NEW.touch_msg    AND NOT OLD.touch_msg)   OR
       (NEW.touch_li     AND NOT OLD.touch_li)    OR
       (NEW.touch_follow AND NOT OLD.touch_follow) THEN
        NEW.last_outreach_at := NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS crm_prospects_stamp_outreach ON public.crm_prospects;
CREATE TRIGGER crm_prospects_stamp_outreach BEFORE UPDATE ON public.crm_prospects
    FOR EACH ROW EXECUTE FUNCTION public.crm_prospects_stamp_outreach();

-- Sales-owned, like the touch boxes themselves (RLS still gates who).
GRANT UPDATE (last_outreach_at) ON public.crm_prospects TO authenticated;

UPDATE public.crm_prospects
   SET last_outreach_at = updated_at
 WHERE last_outreach_at IS NULL
   AND (touch_call OR touch_mail OR touch_msg OR touch_li OR touch_follow);

COMMIT;

NOTIFY pgrst, 'reload schema';
