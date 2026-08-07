-- 021_email_events.sql — Brevo delivery feedback closes the loop on email
-- quality: a hard bounce is ground truth that an address is dead, and a spam
-- complaint is ground truth that a prospect must never be mailed again.
-- The webhook (frontend /api/brevo-events, service_role) calls this RPC; the
-- dataset self-heals as outreach happens instead of re-mailing dead inboxes.
--
-- Event handling (Brevo transactional + campaign vocabularies):
--   hard_bounce / invalid_email / blocked  → contact email_status 'invalid'
--                                            (same terminal state Apollo
--                                            re-verification writes)
--   spam / complaint                       → crm_suppression + every prospect
--                                            holding the address goes status
--                                            'suppressed' (hidden from "All
--                                            open"; sales can un-suppress)
--   unsubscribed / unsubscribe             → crm_suppression only (the
--                                            address works; it must simply
--                                            never be mailed again)
--   soft_bounce / deferred / anything else → counted, nothing written
-- Apply: docker exec -i underwings-db psql -U postgres -d underwings < this

CREATE OR REPLACE FUNCTION public.crm_email_event(p_email TEXT, p_event TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_email      TEXT := lower(trim(p_email));
    v_contacts   INT  := 0;
    v_suppressed INT  := 0;
BEGIN
    IF v_email IS NULL OR position('@' IN v_email) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad email');
    END IF;

    IF p_event IN ('hard_bounce', 'invalid_email', 'blocked') THEN
        UPDATE crm_prospect_contacts
           SET email_status = 'invalid'
         WHERE lower(email) = v_email
           AND email_status IS DISTINCT FROM 'invalid';
        GET DIAGNOSTICS v_contacts = ROW_COUNT;

    ELSIF p_event IN ('spam', 'complaint', 'unsubscribed', 'unsubscribe') THEN
        INSERT INTO crm_suppression (email, reason)
        VALUES (v_email, 'brevo:' || p_event)
        ON CONFLICT ((lower(email))) DO NOTHING;

        IF p_event IN ('spam', 'complaint') THEN
            UPDATE crm_prospects
               SET status = 'suppressed'
             WHERE status <> 'suppressed'
               AND id IN (SELECT prospect_id FROM crm_prospect_contacts
                           WHERE lower(email) = v_email);
            GET DIAGNOSTICS v_suppressed = ROW_COUNT;
        END IF;
    END IF;

    RETURN jsonb_build_object('ok', true, 'event', p_event,
                              'contacts', v_contacts, 'suppressed', v_suppressed);
END;
$$;

-- The webhook authenticates to PostgREST as service_role and nothing else
-- may reach this: it writes sales-visible state from an unauthenticated-ish
-- HTTP surface, so the token check in the endpoint plus this grant are the
-- entire trust chain.
REVOKE ALL ON FUNCTION public.crm_email_event(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crm_email_event(TEXT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_email_event(TEXT, TEXT) TO service_role;

-- New function is invisible to PostgREST until its schema cache reloads.
NOTIFY pgrst, 'reload schema';
