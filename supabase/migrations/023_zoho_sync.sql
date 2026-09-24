-- 023_zoho_sync.sql — Zoho CRM lead sync bookkeeping + traffic attribution.
-- zoho_lead_id NULL == not yet in Zoho; /api/admin/zoho-resync re-pushes those.
ALTER TABLE public.form_submissions
  ADD COLUMN IF NOT EXISTS zoho_lead_id text,
  ADD COLUMN IF NOT EXISTS zoho_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS zoho_error text;
ALTER TABLE public.waitlist_signups
  ADD COLUMN IF NOT EXISTS attribution jsonb,
  ADD COLUMN IF NOT EXISTS zoho_lead_id text,
  ADD COLUMN IF NOT EXISTS zoho_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS zoho_error text;
ALTER TABLE public.subscribers
  ADD COLUMN IF NOT EXISTS attribution jsonb,
  ADD COLUMN IF NOT EXISTS zoho_lead_id text,
  ADD COLUMN IF NOT EXISTS zoho_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS zoho_error text;
CREATE INDEX IF NOT EXISTS form_submissions_zoho_pending ON public.form_submissions (created_at) WHERE zoho_lead_id IS NULL;
CREATE INDEX IF NOT EXISTS waitlist_signups_zoho_pending ON public.waitlist_signups (captured_at) WHERE zoho_lead_id IS NULL;
CREATE INDEX IF NOT EXISTS subscribers_zoho_pending ON public.subscribers (id) WHERE zoho_lead_id IS NULL;
NOTIFY pgrst, 'reload schema';
