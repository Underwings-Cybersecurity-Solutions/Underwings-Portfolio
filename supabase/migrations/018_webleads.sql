-- 018_webleads.sql — the CRM "Web Leads" tab (2026-08-05).
--
-- form_submissions predates the CRM and shipped with ROW LEVEL SECURITY
-- DISABLED while anon held SELECT: the public anon key could read every
-- submission — name, email, phone, message — straight through PostgREST
-- (verified live before this migration). The is_admin() policy on it was
-- decoration, since policies don't apply while RLS is off.
--
-- This migration
--   1. closes that hole (enable RLS, revoke anon),
--   2. keeps the CMS admin console working (its "Admins can manage
--      submissions" ALL policy already exists and starts applying),
--   3. keeps the website APIs writing (service_role policy, mirroring
--      subscribers_service_all — service_role does NOT bypass RLS here),
--   4. lets CRM members read submissions and triage exactly two columns
--      (lead_status, admin_notes) at aal2 — the same column-grant split as
--      crm_prospects (011/013/016): RLS gates the rows, GRANTs the columns.

BEGIN;

-- ---------------- form_submissions: close the hole ----------------------
ALTER TABLE public.form_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_submissions FROM anon;

CREATE POLICY form_submissions_service_all ON public.form_submissions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "crm users read submissions" ON public.form_submissions
  FOR SELECT TO authenticated
  USING (public.is_crm_user() AND (auth.jwt() ->> 'aal') = 'aal2');

CREATE POLICY "crm users triage submissions" ON public.form_submissions
  FOR UPDATE TO authenticated
  USING (public.is_crm_user() AND (auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK (public.is_crm_user() AND (auth.jwt() ->> 'aal') = 'aal2');

-- authenticated keeps SELECT/INSERT/DELETE for the admin console (row-gated
-- by is_admin()); UPDATE becomes column-scoped — admin-console columns plus
-- the two CRM triage columns.
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.form_submissions FROM authenticated;
GRANT UPDATE (status, notes, assigned_to, lead_status, admin_notes)
  ON public.form_submissions TO authenticated;

-- ---------------- subscribers: add the triage half ----------------------
-- (CRM read exists since 010; admin + service policies already in place.)
REVOKE ALL ON public.subscribers FROM anon;
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.subscribers FROM authenticated;
GRANT UPDATE (subscribed, lead_status, admin_notes)
  ON public.subscribers TO authenticated;

CREATE POLICY "crm users triage subscribers" ON public.subscribers
  FOR UPDATE TO authenticated
  USING (public.is_crm_user() AND (auth.jwt() ->> 'aal') = 'aal2')
  WITH CHECK (public.is_crm_user() AND (auth.jwt() ->> 'aal') = 'aal2');

COMMIT;

-- PostgREST caches the schema: new policies/grants are invisible to the API
-- until it reloads.
NOTIFY pgrst, 'reload schema';
