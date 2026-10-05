-- P0-7: every evidence PDF is sealed (SHA-256 of the pack + HMAC signature) so a returning officer can verify it.
CREATE TABLE evidence_seals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id       uuid NOT NULL,
  sha256       text NOT NULL,
  signature    text NOT NULL,
  generated_at timestamptz NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_seals_run ON evidence_seals (tenant_id, run_id);
ALTER TABLE evidence_seals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON evidence_seals USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON evidence_seals TO cs_app;  -- a seal is a record: never edited or removed by the app

-- Public verification by seal id (no login, no tenant data beyond what is printed on the PDF).
CREATE FUNCTION evidence_seal_public(p_id uuid)
RETURNS TABLE (id uuid, sha256 text, signature text, generated_at timestamptz, run_id uuid, campaign_name text, region text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.sha256, s.signature, s.generated_at, s.run_id, t.campaign_name, t.region
  FROM evidence_seals s JOIN tenants t ON t.id = s.tenant_id WHERE s.id = p_id;
$$;
REVOKE ALL ON FUNCTION evidence_seal_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence_seal_public(uuid) TO cs_app;
