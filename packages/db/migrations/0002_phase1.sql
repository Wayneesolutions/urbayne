-- Phase 1: demo tenants, public hub, calls, share links, assistant log.

ALTER TABLE tenants ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN slug text UNIQUE;
ALTER TABLE tenants ADD COLUMN candidate_name text;
ALTER TABLE tenants ADD COLUMN tagline text;
ALTER TABLE tenants ADD COLUMN official_info_url text;

ALTER TABLE content_items ADD COLUMN geo_area_id uuid REFERENCES geo_areas(id);
-- Survey questions are part of the approved/certified content, so editing them resets approval.
ALTER TABLE content_items ADD COLUMN survey jsonb;

CREATE TABLE campaign_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('voice','sms')),
  content_item_id uuid NOT NULL REFERENCES content_items(id),
  purpose         text NOT NULL CHECK (purpose IN ('info','survey','reminder','donation')),
  audience        jsonb NOT NULL DEFAULT '{}',     -- { geoAreaIds?: [], tags?: [] }
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','paused','completed','blocked')),
  gate_result     jsonb,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE interactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id          uuid REFERENCES campaign_runs(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  channel         text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('outbound','inbound')),
  content_item_id uuid REFERENCES content_items(id),
  provider        text,
  provider_ref    text,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','blocked','in_progress','completed','no_answer','failed')),
  block_reasons   jsonb,
  started_at      timestamptz,
  ended_at        timestamptz,
  duration_sec    int,
  transcript      text,
  ai_disclosed    boolean NOT NULL DEFAULT false,
  opted_out       boolean NOT NULL DEFAULT false,
  follow_up       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interactions_run ON interactions (run_id, status);

CREATE TABLE survey_responses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  interaction_id uuid NOT NULL REFERENCES interactions(id) ON DELETE CASCADE,
  question_key   text NOT NULL,
  answer_value   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE share_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code           text NOT NULL UNIQUE,
  label          text NOT NULL,
  geo_area_id    uuid REFERENCES geo_areas(id),
  worker_user_id uuid REFERENCES users(id),
  clicks         int NOT NULL DEFAULT 0,
  signups        int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assistant_questions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  question          text NOT NULL,
  locale            text NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('answered','handoff','official_link')),
  cited_content_id  uuid REFERENCES content_items(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE campaign_runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_responses    ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_links         ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON campaign_runs       USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON interactions        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON survey_responses    USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON share_links         USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON assistant_questions USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Public entry points resolve a slug or share code to a tenant id without opening RLS.
CREATE FUNCTION tenant_by_slug(p_slug text)
RETURNS TABLE (id uuid, region text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, region FROM tenants WHERE slug = p_slug AND status = 'active';
$$;

CREATE FUNCTION resolve_share_link(p_code text)
RETURNS TABLE (tenant_id uuid, slug text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE share_links s SET clicks = clicks + 1, updated_at = now()
  FROM tenants t WHERE s.code = p_code AND t.id = s.tenant_id AND t.status = 'active'
  RETURNING s.tenant_id, t.slug;
$$;

REVOKE ALL ON FUNCTION tenant_by_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_share_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_by_slug(text) TO cs_app;
GRANT EXECUTE ON FUNCTION resolve_share_link(text) TO cs_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON campaign_runs, interactions, survey_responses, share_links, assistant_questions TO cs_app;
