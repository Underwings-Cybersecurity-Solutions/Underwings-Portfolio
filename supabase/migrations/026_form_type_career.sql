-- 026_form_type_career.sql — allow careers applications from /api/careers.
-- The application is stored with form_type = 'career'; role, links and the
-- CV filename live in `metadata`. The CV file itself is only emailed to
-- careers@underwings.org and never stored in the database.
-- Keeps every value from 025 (incl. 'linkedin_ad' for the LinkedIn mirror).
ALTER TABLE public.form_submissions DROP CONSTRAINT IF EXISTS form_submissions_form_type_check;
ALTER TABLE public.form_submissions ADD CONSTRAINT form_submissions_form_type_check
  CHECK (form_type = ANY (ARRAY['contact'::text, 'quote'::text, 'newsletter'::text, 'consultation'::text, 'linkedin_ad'::text, 'career'::text]));
NOTIFY pgrst, 'reload schema';
