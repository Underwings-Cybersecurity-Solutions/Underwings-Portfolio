-- 015_contact_dedupe.sql — one row per (prospect, email).
--
-- Now that the pipeline writes EVERY harvested address rather than one best
-- guess (store-pg.toContactRows), a re-harvest of the same company could
-- otherwise stack the same address again and again: nothing in the schema
-- said an address was unique per prospect, and `replaceContact` only ever
-- INSERTs. The index makes the invariant structural, and lets the writer use
-- ON CONFLICT DO NOTHING instead of read-then-decide.
--
-- Plain columns, NOT lower(email): PostgREST's `on_conflict=` can only name
-- real columns, so an expression index would be unusable from the pipeline
-- ("no unique or exclusion constraint matching the ON CONFLICT
-- specification"). Case-insensitivity is handled by store-pg lower-casing
-- every address before it is written; the existing lower(email) lookup index
-- stays for queries.
--
-- NOT partial, either. `WHERE email IS NOT NULL` looks right — phone-only
-- rows are legitimate — but Postgres can only infer a PARTIAL index for
-- ON CONFLICT when the statement repeats the predicate, and PostgREST's
-- `on_conflict=` parameter cannot express a WHERE clause: every upsert came
-- back "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification". The predicate is also redundant, because a unique index
-- treats NULLs as distinct, so any number of phone-only rows still fit.

BEGIN;

DROP INDEX IF EXISTS public.uq_crm_prospect_contacts_email;

UPDATE public.crm_prospect_contacts
   SET email = lower(email)
 WHERE email IS NOT NULL AND email <> lower(email);

-- any pre-existing duplicate would block the index; keep the highest-
-- confidence row of each group (ties broken by oldest id, deterministically)
DELETE FROM public.crm_prospect_contacts c
 USING public.crm_prospect_contacts keep
 WHERE c.email IS NOT NULL
   AND keep.prospect_id = c.prospect_id
   AND keep.email = c.email
   AND (COALESCE(keep.confidence, -1), keep.id) > (COALESCE(c.confidence, -1), c.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_prospect_contacts_email
    ON public.crm_prospect_contacts (prospect_id, email);

COMMIT;

NOTIFY pgrst, 'reload schema';
