-- ===========================================
-- MIGRATION 009: crm_members() — roster of CRM users (id,email,role) for the
-- owner picker + owner-avatar display. SECURITY DEFINER (reads auth.users),
-- gated on is_crm_user() so only CRM members can enumerate the team.
-- ===========================================
CREATE OR REPLACE FUNCTION public.crm_members()
RETURNS TABLE (id UUID, email TEXT, role TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_crm_user() THEN RETURN; END IF;
  RETURN QUERY
    SELECT c.id, u.email::text, c.role
    FROM public.crm_users c
    JOIN auth.users u ON u.id = c.id
    ORDER BY c.role, u.email;
END;
$$;
REVOKE ALL ON FUNCTION public.crm_members() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crm_members() TO anon, authenticated;
