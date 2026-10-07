-- Phase 5: pricing packages, usage metering and per-campaign invoicing.
-- Prices are data, not code: platform staff define packages here and assign one to each campaign. A campaign's terms are copied
-- onto its subscription when assigned, so editing a package later never changes a deal already made.

CREATE TABLE plans (
  code          text PRIMARY KEY CHECK (code ~ '^[a-z0-9_-]{2,40}$'),
  name          text NOT NULL,
  region        text NOT NULL CHECK (region IN ('IN', 'CA')),
  currency      text NOT NULL CHECK (currency IN ('INR', 'CAD')),
  billing       text NOT NULL CHECK (billing IN ('per_campaign', 'monthly')),
  price_minor   bigint NOT NULL CHECK (price_minor >= 0),
  -- Units included in the price, units charged beyond that, and units that cannot be exceeded.
  -- Keys: smsSent, callMinutes, assistantQuestions, contacts, teamMembers. (contacts and teamMembers have no overage price: they are only capped.)
  included      jsonb NOT NULL DEFAULT '{}',
  overage_minor jsonb NOT NULL DEFAULT '{}',
  hard_limits   jsonb NOT NULL DEFAULT '{}',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON plans TO cs_app;

ALTER TABLE subscriptions ADD COLUMN plan_code text REFERENCES plans(code);
ALTER TABLE subscriptions ADD COLUMN billing text NOT NULL DEFAULT 'monthly' CHECK (billing IN ('per_campaign', 'monthly'));
ALTER TABLE subscriptions ADD COLUMN terms jsonb;     -- snapshot of the package's included / overage / hard limits when it was assigned
ALTER TABLE subscriptions ADD COLUMN discount_percent numeric(5,2) CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100));
GRANT UPDATE (plan_code, billing, terms, discount_percent) ON subscriptions TO cs_app;

-- Billing run: all subscriptions across campaigns (platform staff only), with the package terms.
DROP FUNCTION billing_tenants();
CREATE FUNCTION billing_tenants()
RETURNS TABLE (tenant_id uuid, campaign_name text, region text, kind text, plan text, price_minor bigint, sms_rate_minor bigint, sms_included int,
               tax_percent numeric, status text, started_on date, plan_code text, billing text, terms jsonb, discount_percent numeric)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.tenant_id, t.campaign_name, t.region, t.kind, s.plan, s.price_minor, s.sms_rate_minor, s.sms_included, s.tax_percent, s.status, s.started_on,
         s.plan_code, s.billing, s.terms, s.discount_percent
  FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id;
$$;
REVOKE ALL ON FUNCTION billing_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_tenants() TO cs_app;
