-- Phase 4: agency view for political consultancies that run several campaigns, with optional white-label branding.
--
-- An agency never gets a campaign's data by itself. A campaign owner creates a one-time invite code and gives it to the agency;
-- the agency redeems it, which links the two. The agency overview shows totals only (counts, spending against the limit,
-- pending approvals): never a contact, a phone number, a transcript or a ticket's text. The owner can revoke the link at any time.
-- To work inside a campaign, agency staff are added to its team in the usual way and get a normal role there.

CREATE TABLE agencies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  brand_name    text CHECK (brand_name IS NULL OR length(brand_name) BETWEEN 2 AND 80),   -- shown instead of the platform name when white-label is on
  primary_color text CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  support_email text CHECK (support_email IS NULL OR support_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agency_members (
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('admin', 'staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, user_id)
);

-- One-time codes a campaign owner hands to an agency. Only the hash is stored.
CREATE TABLE agency_invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code_hash  text NOT NULL UNIQUE,
  white_label boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agency_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  white_label boolean NOT NULL DEFAULT false,      -- the campaign's own team sees the agency's brand name and colour
  linked_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  UNIQUE (agency_id, tenant_id)
);
-- A campaign has at most one white-label agency.
CREATE UNIQUE INDEX agency_links_one_brand ON agency_links (tenant_id) WHERE white_label AND status = 'active';

-- The campaign's own side: owners see and manage their invites and links. The agency side goes through the functions below.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['agency_invites', 'agency_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON agency_invites TO cs_app;
GRANT SELECT, UPDATE (status, white_label, revoked_at) ON agency_links TO cs_app;
GRANT SELECT, INSERT, UPDATE ON agencies TO cs_app;
GRANT SELECT, INSERT, UPDATE (role), DELETE ON agency_members TO cs_app;

-- Agency redeems an invite code: links the agency to the campaign. Returns nothing when the code is wrong, expired or used.
CREATE FUNCTION redeem_agency_invite(p_code_hash text, p_agency uuid, p_user uuid)
RETURNS TABLE (link_id uuid, tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE inv agency_invites%ROWTYPE; lid uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agency_members m WHERE m.agency_id = p_agency AND m.user_id = p_user AND m.role = 'admin') THEN RETURN; END IF;
  SELECT * INTO inv FROM agency_invites i WHERE i.code_hash = p_code_hash AND i.used_at IS NULL AND i.expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF inv.white_label AND EXISTS (SELECT 1 FROM agency_links l WHERE l.tenant_id = inv.tenant_id AND l.white_label AND l.status = 'active' AND l.agency_id <> p_agency) THEN RETURN; END IF;
  UPDATE agency_invites SET used_at = now() WHERE id = inv.id;
  INSERT INTO agency_links (agency_id, tenant_id, white_label, linked_by) VALUES (p_agency, inv.tenant_id, inv.white_label, p_user)
    ON CONFLICT (agency_id, tenant_id) DO UPDATE SET status = 'active', revoked_at = NULL, white_label = EXCLUDED.white_label, linked_by = EXCLUDED.linked_by
    RETURNING id INTO lid;
  link_id := lid; tenant_id := inv.tenant_id; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION redeem_agency_invite(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redeem_agency_invite(text, uuid, uuid) TO cs_app;

-- The campaigns an agency may see: active links, and only for a member of that agency.
CREATE FUNCTION agency_linked_tenants(p_agency uuid, p_user uuid)
RETURNS TABLE (link_id uuid, tenant_id uuid, white_label boolean, linked_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT l.id, l.tenant_id, l.white_label, l.created_at FROM agency_links l
  WHERE l.agency_id = p_agency AND l.status = 'active'
    AND EXISTS (SELECT 1 FROM agency_members m WHERE m.agency_id = p_agency AND m.user_id = p_user)
  ORDER BY l.created_at;
$$;
REVOKE ALL ON FUNCTION agency_linked_tenants(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agency_linked_tenants(uuid, uuid) TO cs_app;

-- The white-label agency of a campaign (name, colour, support address), for the campaign's own dashboard.
CREATE FUNCTION tenant_branding(p_tenant uuid)
RETURNS TABLE (agency_id uuid, name text, brand_name text, primary_color text, support_email text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.name, a.brand_name, a.primary_color, a.support_email FROM agency_links l JOIN agencies a ON a.id = l.agency_id
  WHERE l.tenant_id = p_tenant AND l.white_label AND l.status = 'active';
$$;
REVOKE ALL ON FUNCTION tenant_branding(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_branding(uuid) TO cs_app;
