-- The ticket timeline is append-only for the app. Removing a resident's personal details (retention or erasure) has to blank the
-- free-text notes in it, so that one narrow operation is a function, and it only works inside the caller's own campaign.
CREATE FUNCTION scrub_ticket_events(p_ticket uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE ticket_events SET body = NULL
  WHERE ticket_id = p_ticket
    AND kind IN ('note', 'edited')
    AND tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;
REVOKE ALL ON FUNCTION scrub_ticket_events(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scrub_ticket_events(uuid) TO cs_app;
