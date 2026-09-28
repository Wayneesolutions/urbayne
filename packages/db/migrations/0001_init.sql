-- Campaign Technology Suite: phase 0 schema.
-- Every tenant-scoped table has tenant_id and a Row-Level Security policy.
-- The API connects as cs_app (RLS enforced). Migrations run as the owner role.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Local-dev app role. In production create it with a secret password via infra.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cs_app') THEN
    CREATE ROLE cs_app LOGIN PASSWORD 'cs_app';
  END IF;
END $$;

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region          text NOT NULL CHECK (region IN ('IN','CA')),
  race_type       text NOT NULL CHECK (race_type IN ('assembly','parliament','municipal','ward','trustee','panchayat','other')),
  seat_code       text NOT NULL,           -- constituency / ward code
  election_date   date NOT NULL,
  campaign_name   text NOT NULL,           -- as spoken in disclosures
  time_zone       text NOT NULL,
  poll_close_at   timestamptz,
  enabled_modules text[] NOT NULL DEFAULT '{}',
  calling_hours_override jsonb,            -- counsel-confirmed only
  spend_limit_minor bigint,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  override_reason text,                    -- set only by wes_admin; logged
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- One race, one client: at most one active tenant per seat and election,
-- unless a logged admin override exists.
CREATE UNIQUE INDEX tenants_one_race_one_client
  ON tenants (region, race_type, seat_code, election_date)
  WHERE status = 'active' AND override_reason IS NULL;

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash  text NOT NULL UNIQUE,
  phone_enc   text NOT NULL,
  name        text,
  locale      text NOT NULL DEFAULT 'en',
  is_wes_admin boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash  text NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_phone ON otp_codes (phone_hash, created_at DESC);

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','manager','finance_agent','coordinator','field_worker','agent_reporter','service_staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE geo_areas (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id  uuid REFERENCES geo_areas(id),
  level      text NOT NULL,     -- constituency | ward | booth | locality | street ...
  code       text,
  name_en    text NOT NULL,
  name_pa    text,
  name_hi    text,
  polygon    jsonb,             -- GeoJSON; PostGIS later if needed
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_hash  text NOT NULL,
  phone_enc   text NOT NULL,
  name        text,
  geo_area_id uuid REFERENCES geo_areas(id),
  time_zone   text,
  source      text NOT NULL CHECK (source IN ('form','missed_call','roll','import')),
  source_proof_file text,       -- required for 'roll' and 'import' (enforced in API)
  opted_out   boolean NOT NULL DEFAULT false,
  tags        text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_hash)
);
-- Deliberately NO caste / religion columns (guardrail).

CREATE TABLE consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  purpose       text NOT NULL CHECK (purpose IN ('info','survey','reminder','donation')),
  channel       text NOT NULL CHECK (channel IN ('voice','sms','ai_answer')),
  text_version  text NOT NULL,
  locale        text NOT NULL,
  captured_via  text NOT NULL,   -- form | missed_call | ivr | paper
  captured_at   timestamptz NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('script','sms_template','page','faq','ad')),
  locale          text NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','certified')),
  certificate_no  text,
  dlt_template_id text,
  approved_by     uuid REFERENCES users(id),
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'certified' OR certificate_no IS NOT NULL)
);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  actor_id  uuid REFERENCES users(id),
  action    text NOT NULL,
  entity    text NOT NULL,
  entity_id text,
  before    jsonb,
  after     jsonb,
  ip        text,
  at        timestamptz NOT NULL DEFAULT now()
);

-- ---------- Row-Level Security ----------
-- The API sets app.tenant_id per transaction: SELECT set_config('app.tenant_id', $1, true)

ALTER TABLE tenants       ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships   ENABLE ROW LEVEL SECURITY;
ALTER TABLE geo_areas     ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log     ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_self ON tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (true);  -- inserts happen before a tenant id exists

CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON geo_areas
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON contacts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON consents
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON content_items
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- audit_log: append from any tenant context, read only own tenant's rows.
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY audit_read ON audit_log FOR SELECT
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cs_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cs_app;
REVOKE UPDATE, DELETE ON audit_log FROM cs_app;  -- append-only

-- Lets a signed-in user list their campaigns across tenants without
-- weakening RLS: returns only rows for the given user.
CREATE FUNCTION user_memberships(p_user uuid)
RETURNS TABLE (tenant_id uuid, role text, campaign_name text, region text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT m.tenant_id, m.role, t.campaign_name, t.region
  FROM memberships m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user AND t.status = 'active';
$$;
REVOKE ALL ON FUNCTION user_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_memberships(uuid) TO cs_app;
