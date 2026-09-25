-- 025_form_type_linkedin.sql — allow the LinkedIn ad-lead mirror to write rows.
-- form_submissions.form_type was constrained to contact/quote/newsletter/
-- consultation; /api/admin/linkedin-sync inserts form_type = 'linkedin_ad'.
ALTER TABLE public.form_submissions DROP CONSTRAINT IF EXISTS form_submissions_form_type_check;
ALTER TABLE public.form_submissions ADD CONSTRAINT form_submissions_form_type_check
  CHECK (form_type = ANY (ARRAY['contact'::text, 'quote'::text, 'newsletter'::text, 'consultation'::text, 'linkedin_ad'::text]));
NOTIFY pgrst, 'reload schema';
