-- 024_zoho_attempts.sql — retry budget for the nightly Zoho resync.
-- A row Zoho rejects permanently (bad email, removed picklist value) used to stay
-- pending forever and alert every night. Now each failed attempt increments
-- zoho_attempts; the resync skips rows at 5+ (99 = permanent, never retried).
ALTER TABLE public.form_submissions ADD COLUMN IF NOT EXISTS zoho_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.waitlist_signups ADD COLUMN IF NOT EXISTS zoho_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.subscribers      ADD COLUMN IF NOT EXISTS zoho_attempts integer NOT NULL DEFAULT 0;
NOTIFY pgrst, 'reload schema';
