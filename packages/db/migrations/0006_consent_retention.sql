-- P0-8: consent evidence (paper and IVR), a suppression list that survives deletion, and the post-election data deletion job.

-- Where did a consent come from? Paper: the form / sheet serial number. IVR: the call (interaction) id.
ALTER TABLE consents ADD COLUMN evidence_ref text;
ALTER TABLE consents ADD COLUMN captured_by uuid REFERENCES users(id);

-- Retention promise per campaign: personal data is deleted this many days after the election. NULL = not set (nothing is deleted automatically).
ALTER TABLE tenants ADD COLUMN retention_days int CHECK (retention_days IS NULL OR retention_days BETWEEN 7 AND 3650);
ALTER TABLE tenants ADD COLUMN purged_at timestamptz;

-- Keyed phone hashes of people who must never be contacted again (opted out or asked to be erased).
-- Only the one-way hash is kept, never the number, so deleting a contact cannot make them callable again.
CREATE TABLE suppressions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_hash text NOT NULL,
  reason     text NOT NULL CHECK (reason IN ('opted_out', 'erasure_request')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_hash)
);

-- A record of every deletion: what kind, when, how many rows. Never contains personal data.
CREATE TABLE data_purges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('retention', 'owner_request', 'contact_erasure')),
  counts       jsonb NOT NULL,
  requested_by uuid,
  ran_at       timestamptz NOT NULL DEFAULT now()
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['suppressions', 'data_purges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON suppressions, data_purges TO cs_app;       -- records: never edited or removed by the app
GRANT DELETE ON suppressions TO cs_app;                            -- only so a person who re-consents in writing can be restored (owner action)

-- Whoever opts out is added to the suppression list automatically, however the opt-out happened.
CREATE FUNCTION contact_suppress_on_opt_out() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.opted_out THEN
    INSERT INTO suppressions (tenant_id, phone_hash, reason) VALUES (NEW.tenant_id, NEW.phone_hash, 'opted_out')
    ON CONFLICT (tenant_id, phone_hash) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contacts_suppress AFTER INSERT OR UPDATE OF opted_out ON contacts
  FOR EACH ROW EXECUTE FUNCTION contact_suppress_on_opt_out();
INSERT INTO suppressions (tenant_id, phone_hash, reason)
  SELECT tenant_id, phone_hash, 'opted_out' FROM contacts WHERE opted_out ON CONFLICT DO NOTHING;

-- The retention job runs across campaigns, so it needs one narrow door past row-level security: ids of campaigns due for deletion.
CREATE FUNCTION tenants_due_for_purge(p_now timestamptz)
RETURNS TABLE (id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id FROM tenants t
  WHERE t.retention_days IS NOT NULL AND t.purged_at IS NULL
    AND (t.election_date + t.retention_days) <= (p_now AT TIME ZONE 'UTC')::date;
$$;
REVOKE ALL ON FUNCTION tenants_due_for_purge(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenants_due_for_purge(timestamptz) TO cs_app;
