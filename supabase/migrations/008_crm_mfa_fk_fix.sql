-- ===========================================
-- MIGRATION 008: CRM MFA + FK fixes
--   S1: enforce aal2 (MFA) in RLS on the 7 crm_* data tables — the client-side
--       MFA screen alone doesn't stop a password-only (aal1) session from
--       reading/writing customer PII straight through PostgREST. crm_users
--       policies are deliberately left untouched (see note below).
--   I2: crm_activities.actor_id / crm_deals.owner_id still reference
--       public.admin_users(id) (migration 006), but the stage-change trigger
--       inserts actor_id = auth.uid() for the AUTHENTICATED user, who may be
--       a crm_users member with no row in admin_users at all → FK violation
--       23503 → the whole stage UPDATE rolls back. Repoint both FKs to
--       auth.users(id) ON DELETE SET NULL.
--   Idempotent; safe to re-run.
-- ===========================================

-- ---------- S1: add aal2 requirement to the 7 crm_* data-table policies ----------
-- NOTE: crm_users policies are intentionally NOT touched here. Its SELECT
-- policy must stay is_crm_user() at aal1 so the app's membership check in
-- afterAuthed() can run BEFORE the user reaches the MFA screen — otherwise a
-- legitimate member who hasn't verified MFA yet would be bounced with "no CRM
-- access" instead of being routed to MFA enroll/verify.
-- NOTE: the aal2 check lives in the policy USING/WITH CHECK clauses, not
-- inside is_crm_user()/is_crm_admin() — those functions are also relied on
-- (at aal1) by the crm_users policies above.
-- NOTE: service-role writes (leadgen, contact form) bypass RLS entirely via
-- the service_role key, so this has no effect on those paths.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crm_companies','crm_contacts','crm_deals','crm_activities',
    'crm_suppression','crm_prospects','crm_prospect_contacts'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "crm read" ON public.%I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "crm write" ON public.%I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "crm modify" ON public.%I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "crm delete" ON public.%I;', t);
    EXECUTE format($f$CREATE POLICY "crm read" ON public.%I FOR SELECT USING (public.is_crm_user() AND (auth.jwt()->>'aal') = 'aal2');$f$, t);
    EXECUTE format($f$CREATE POLICY "crm write" ON public.%I FOR INSERT WITH CHECK (public.is_crm_user() AND (auth.jwt()->>'aal') = 'aal2');$f$, t);
    EXECUTE format($f$CREATE POLICY "crm modify" ON public.%I FOR UPDATE USING (public.is_crm_user() AND (auth.jwt()->>'aal') = 'aal2') WITH CHECK (public.is_crm_user() AND (auth.jwt()->>'aal') = 'aal2');$f$, t);
    EXECUTE format($f$CREATE POLICY "crm delete" ON public.%I FOR DELETE USING (public.is_crm_admin() AND (auth.jwt()->>'aal') = 'aal2');$f$, t);
  END LOOP;
END $$;

-- ---------- I2: repoint crm_activities.actor_id / crm_deals.owner_id off admin_users ----------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'crm_activities_actor_id_fkey' AND conrelid = 'public.crm_activities'::regclass
  ) THEN
    ALTER TABLE public.crm_activities DROP CONSTRAINT crm_activities_actor_id_fkey;
  END IF;
  ALTER TABLE public.crm_activities
    ADD CONSTRAINT crm_activities_actor_id_fkey
    FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'crm_deals_owner_id_fkey' AND conrelid = 'public.crm_deals'::regclass
  ) THEN
    ALTER TABLE public.crm_deals DROP CONSTRAINT crm_deals_owner_id_fkey;
  END IF;
  ALTER TABLE public.crm_deals
    ADD CONSTRAINT crm_deals_owner_id_fkey
    FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;
END $$;
