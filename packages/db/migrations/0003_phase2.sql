-- Phase 2: field canvassing, events/volunteers/signs, finance.

CREATE TABLE turfs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  geo_area_id      uuid NOT NULL REFERENCES geo_areas(id),
  name             text NOT NULL,
  assigned_user_id uuid REFERENCES users(id),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE door_visits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  turf_id     uuid NOT NULL REFERENCES turfs(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  household   text,                 -- for doors not in the contact list
  result      text NOT NULL CHECK (result IN ('supporter','undecided','not_interested','not_home','needs_help','wants_sign')),
  note        text,
  worker_id   uuid REFERENCES users(id),
  visited_at  timestamptz NOT NULL,
  client_uuid uuid NOT NULL,        -- idempotent offline sync
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_uuid),
  CHECK (contact_id IS NOT NULL OR household IS NOT NULL)
);

CREATE TABLE events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('sabha','rally','vehicle','door_knock','meeting','office_hours')),
  title             text NOT NULL,
  geo_area_id       uuid REFERENCES geo_areas(id),
  location          text,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz,
  permission_status text NOT NULL DEFAULT 'not_applied' CHECK (permission_status IN ('not_needed','not_applied','applied','granted','refused')),
  permission_ref    text,
  status            text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','confirmed','done','cancelled')),
  cost_minor        bigint,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shifts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id   uuid REFERENCES events(id) ON DELETE CASCADE,
  title      text NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz,
  needed     int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shift_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id    uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  reminded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, contact_id)
);

CREATE TABLE signs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  address    text NOT NULL,
  lat        double precision,
  lng        double precision,
  status     text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','placed','collected')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ADD COLUMN finance_locked_until date;
ALTER TABLE tenants ADD COLUMN contribution_limit_minor bigint;   -- CA: per contributor, per election
ALTER TABLE tenants ADD COLUMN office_lat double precision;
ALTER TABLE tenants ADD COLUMN office_lng double precision;

CREATE TABLE rate_list (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item       text NOT NULL,
  unit       text NOT NULL,
  rate_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finance_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('contribution','expense')),
  entry_date        date NOT NULL,
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  category          text NOT NULL,
  description       text NOT NULL,
  party_name        text NOT NULL,        -- paid to / received from
  party_address     text,
  bill_no           text,
  quantity          numeric,
  unit_rate_minor   bigint,
  rate_list_id      uuid REFERENCES rate_list(id),
  payment_mode      text CHECK (payment_mode IN ('cash','cheque','bank','upi','card','other')),
  eligible_attested boolean NOT NULL DEFAULT false,
  receipt_no        text,
  receipt_file      text,
  source            text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','event','call_run')),
  source_ref        uuid,
  flags             jsonb NOT NULL DEFAULT '[]',
  created_by        uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, source_ref)
);

CREATE TABLE finance_signoffs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_to          date NOT NULL,
  expense_minor      bigint NOT NULL,
  contribution_minor bigint NOT NULL,
  entries            int NOT NULL,
  signed_by          uuid NOT NULL REFERENCES users(id),
  signed_at          timestamptz NOT NULL DEFAULT now()
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['turfs','door_visits','events','shifts','shift_assignments','signs','rate_list','finance_entries','finance_signoffs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO cs_app', t);
  END LOOP;
END $$;
-- Sign-offs are a record: never edited or removed by the app.
REVOKE UPDATE, DELETE ON finance_signoffs FROM cs_app;
