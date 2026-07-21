-- ===========================================
-- MIGRATION 007: CRM roles — separate crm_users identity for the standalone
-- crm.underwings.org app (distinct from admin_users/CMS). Swaps all crm_*
-- RLS off is_admin() onto is_crm_user()/is_crm_admin(). Idempotent.
-- ===========================================

CREATE TABLE IF NOT EXISTS public.crm_users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.crm_users ENABLE ROW LEVEL SECURITY;

-- NOTE (deviation from brief ordering, content unchanged): the two role-check
-- functions must exist before the crm_users policies below reference them in
-- USING/WITH CHECK — CREATE POLICY resolves function refs against the catalog
-- at creation time, unlike a view. Moved up; no SQL content altered otherwise.
CREATE OR REPLACE FUNCTION public.is_crm_user()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (SELECT 1 FROM public.crm_users WHERE id = auth.uid());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.is_crm_admin()
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (SELECT 1 FROM public.crm_users WHERE id = auth.uid() AND role = 'admin');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- a CRM user may read the roster; only a CRM admin may change it
DROP POLICY IF EXISTS "crm users readable by crm users" ON public.crm_users;
CREATE POLICY "crm users readable by crm users" ON public.crm_users
    FOR SELECT USING (public.is_crm_user());
DROP POLICY IF EXISTS "crm users managed by crm admin" ON public.crm_users;
CREATE POLICY "crm users managed by crm admin" ON public.crm_users
    FOR ALL USING (public.is_crm_admin()) WITH CHECK (public.is_crm_admin());

-- ---------- swap RLS on every crm_* data table ----------
-- Drop the migration-006 admin policies, add member (read/write) + admin (delete).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'crm_companies','crm_contacts','crm_deals','crm_activities',
    'crm_suppression','crm_prospects','crm_prospect_contacts'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Admins can manage %s" ON public.%I;',
                   replace(t,'crm_',''), t);
    -- exact old names from 006 were "Admins can manage crm companies" etc; also drop those:
    -- (fixed from brief: %L->%I since policy names are identifiers not string
    -- literals, and inserted the literal "crm " token the brief's own formula
    -- omitted — without it this never matches migration 006's real policy names,
    -- e.g. "Admins can manage crm companies", and Step 3's acceptance criterion
    -- of "no Admins can manage... policy remains" could not be met.)
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;',
                   'Admins can manage crm ' || replace(replace(t,'crm_',''),'_',' '), t);
    EXECUTE format('DROP POLICY IF EXISTS "crm read" ON public.%I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "crm write" ON public.%I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "crm modify" ON public.%I;', t);
    EXECUTE format('DROP POLICY IF EXISTS "crm delete" ON public.%I;', t);
    EXECUTE format('CREATE POLICY "crm read" ON public.%I FOR SELECT USING (public.is_crm_user());', t);
    EXECUTE format('CREATE POLICY "crm write" ON public.%I FOR INSERT WITH CHECK (public.is_crm_user());', t);
    EXECUTE format('CREATE POLICY "crm modify" ON public.%I FOR UPDATE USING (public.is_crm_user()) WITH CHECK (public.is_crm_user());', t);
    EXECUTE format('CREATE POLICY "crm delete" ON public.%I FOR DELETE USING (public.is_crm_admin());', t);
  END LOOP;
END $$;
