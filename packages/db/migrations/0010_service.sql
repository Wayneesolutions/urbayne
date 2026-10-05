-- Phase 3, Tool 8: constituent service platform (tickets from web, SMS and a voice helpline; assignment by area;
-- status updates by SMS; monthly reports; subscription billing). Sold to sitting representatives, so it needs no election to run.

-- A person can agree to texts about THEIR request, separate from campaign messages.
ALTER TABLE consents DROP CONSTRAINT consents_purpose_check;
ALTER TABLE consents ADD CONSTRAINT consents_purpose_check CHECK (purpose IN ('info', 'survey', 'reminder', 'donation', 'service'));

-- 'office' = a sitting MLA / MP / councillor's service office. Its data is not deleted on an election date; ticket retention is separate.
ALTER TABLE tenants ADD COLUMN kind text NOT NULL DEFAULT 'campaign' CHECK (kind IN ('campaign', 'office'));
ALTER TABLE tenants ADD COLUMN ticket_seq int NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN service_sla_days int NOT NULL DEFAULT 7 CHECK (service_sla_days BETWEEN 1 AND 90);
-- Personal details on closed tickets are removed this many days after closing. NULL = kept until the owner sets it.
ALTER TABLE tenants ADD COLUMN ticket_retention_days int CHECK (ticket_retention_days IS NULL OR ticket_retention_days BETWEEN 30 AND 3650);

-- The election-date retention job is for campaigns only.
CREATE OR REPLACE FUNCTION tenants_due_for_purge(p_now timestamptz)
RETURNS TABLE (id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id FROM tenants t
  WHERE t.kind = 'campaign' AND t.retention_days IS NOT NULL AND t.purged_at IS NULL
    AND (t.election_date + t.retention_days) <= (p_now AT TIME ZONE 'UTC')::date;
$$;

-- Offices with a ticket retention period (for the daily ticket clean-up job).
CREATE FUNCTION tenants_with_ticket_retention()
RETURNS TABLE (id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id FROM tenants t WHERE t.ticket_retention_days IS NOT NULL AND t.status = 'active';
$$;
REVOKE ALL ON FUNCTION tenants_with_ticket_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenants_with_ticket_retention() TO cs_app;

CREATE TABLE tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  seq                 int  NOT NULL,
  ref                 text NOT NULL,                    -- what the resident is told, for example T-0042
  channel             text NOT NULL CHECK (channel IN ('web', 'sms', 'voice', 'office')),
  category            text NOT NULL CHECK (category IN ('water', 'roads', 'electricity', 'sanitation', 'health', 'welfare', 'education', 'safety', 'other')),
  title               text NOT NULL,
  description         text,
  geo_area_id         uuid REFERENCES geo_areas(id) ON DELETE SET NULL,
  area_text           text,                             -- what the person said, when it did not match a known area
  contact_id          uuid REFERENCES contacts(id) ON DELETE SET NULL,
  requester_name      text,
  language            text,
  status              text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'assigned', 'in_progress', 'resolved', 'closed', 'rejected')),
  priority            text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_to         uuid REFERENCES users(id) ON DELETE SET NULL,
  due_at              timestamptz,
  acknowledged_at     timestamptz,                      -- when the resident was told we got it
  first_response_at   timestamptz,                      -- first time a person on the team picked it up
  resolved_at         timestamptz,
  closed_at           timestamptz,
  resolution_note     text,
  scrubbed_at         timestamptz,                      -- personal details removed (retention or erasure)
  source_ref          text,                             -- provider id (call id, message id): a repeated delivery makes no second ticket
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, seq)
);
CREATE UNIQUE INDEX tickets_source ON tickets (tenant_id, channel, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX tickets_status ON tickets (tenant_id, status, created_at DESC);
CREATE INDEX tickets_area ON tickets (tenant_id, geo_area_id);
CREATE INDEX tickets_assignee ON tickets (tenant_id, assigned_to) WHERE assigned_to IS NOT NULL;

CREATE TABLE ticket_events (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('created', 'assigned', 'status', 'note', 'edited', 'ack_sent', 'update_sent', 'sms_failed')),
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'public')),
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  body       text,
  meta       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_events_ticket ON ticket_events (ticket_id, id);

-- Which team member gets new tickets from which area (the nearest area up the tree wins).
CREATE TABLE service_routes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  geo_area_id uuid NOT NULL REFERENCES geo_areas(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, geo_area_id)
);

-- Inbound SMS numbers and voice helpline numbers. A number belongs to exactly one office, and only platform staff register them.
CREATE TABLE service_numbers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('sms', 'voice')),
  identifier text NOT NULL,                             -- SMS: the number people text (E.164). Voice: the Vapi phone number id
  provider   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, identifier)
);

-- Subscriptions and invoices. Payments are recorded by hand until a payment provider is connected.
CREATE TABLE subscriptions (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan                 text NOT NULL,
  price_minor          bigint NOT NULL CHECK (price_minor >= 0),   -- per month, in the campaign's currency
  sms_rate_minor       bigint NOT NULL DEFAULT 0 CHECK (sms_rate_minor >= 0),   -- per resident text beyond the included amount
  sms_included         int NOT NULL DEFAULT 0 CHECK (sms_included >= 0),
  tax_percent          numeric(5,2),                                -- NULL = not set: confirm with the accountant before invoicing
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'past_due', 'cancelled')),
  started_on           date NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number        text NOT NULL UNIQUE,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  currency      text NOT NULL,
  subtotal_minor bigint NOT NULL,
  tax_minor     bigint NOT NULL DEFAULT 0,
  total_minor   bigint NOT NULL,
  lines         jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'void')),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz,
  UNIQUE (tenant_id, period_start)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tickets', 'ticket_events', 'service_routes', 'service_numbers', 'subscriptions', 'invoices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON tickets TO cs_app;                -- tickets are never deleted by the app: they are scrubbed
GRANT SELECT, INSERT ON ticket_events TO cs_app;                  -- the timeline is a record
GRANT USAGE, SELECT ON SEQUENCE ticket_events_id_seq TO cs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_routes TO cs_app;
GRANT SELECT, INSERT, DELETE ON service_numbers TO cs_app;
GRANT SELECT, INSERT, UPDATE ON subscriptions TO cs_app;
GRANT SELECT, INSERT, UPDATE ON invoices TO cs_app;

-- Webhooks arrive without a campaign: find the office by the number that was contacted.
CREATE FUNCTION service_number_tenant(p_kind text, p_identifier text)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT n.tenant_id FROM service_numbers n JOIN tenants t ON t.id = n.tenant_id
  WHERE n.kind = p_kind AND n.identifier = p_identifier AND t.status = 'active';
$$;
REVOKE ALL ON FUNCTION service_number_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION service_number_tenant(text, text) TO cs_app;

-- Platform staff: all subscriptions and invoices across offices (billing runs), totals only.
CREATE FUNCTION billing_tenants()
RETURNS TABLE (tenant_id uuid, campaign_name text, region text, kind text, plan text, price_minor bigint, sms_rate_minor bigint, sms_included int,
               tax_percent numeric, status text, started_on date)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.tenant_id, t.campaign_name, t.region, t.kind, s.plan, s.price_minor, s.sms_rate_minor, s.sms_included, s.tax_percent, s.status, s.started_on
  FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id;
$$;
REVOKE ALL ON FUNCTION billing_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_tenants() TO cs_app;
