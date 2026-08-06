-- 017_touch_mail.sql — split "messaged" into mail and message.
--
-- Migration 016 shipped four boxes, where `touch_msg` meant "emailed OR
-- messaged". That is the one box the team ticks most, and it collapsed the
-- two channels that behave least alike: a cold email is the drafted outreach
-- this pipeline writes (outreach_subject/outreach_body), while a WhatsApp or
-- SMS is a separate, later move. Rolled together, nobody could tell from the
-- row whether the drafted mail had actually gone out.
--
-- So: `touch_mail` is the drafted cold email being sent, `touch_msg` narrows
-- to WhatsApp/SMS. Existing ticks stay on `touch_msg` — they are genuinely
-- ambiguous and back-dating them into `touch_mail` would invent a fact.
--
-- Sales-owned, like the rest of the touches.

BEGIN;

ALTER TABLE public.crm_prospects
    ADD COLUMN IF NOT EXISTS touch_mail BOOLEAN NOT NULL DEFAULT FALSE;

GRANT UPDATE (touch_mail) ON public.crm_prospects TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
