-- Phase 3, Tool 7: poll day turnout and counting-day results.
-- Everything here is what the CAMPAIGN's own agents report, plus official numbers that a person on the team types in or uploads
-- from the official site. Nothing connects to any official election system.

-- Polling stations are geo areas at the booth (India) or voting-place (Canada) level, with the number of registered electors.
CREATE TABLE polling_stations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  geo_area_id uuid NOT NULL REFERENCES geo_areas(id) ON DELETE CASCADE,
  electors    int CHECK (electors IS NULL OR electors >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, geo_area_id)
);

-- Who may report for which station (scope 'station'), or from the counting hall (scope 'counting').
CREATE TABLE result_agents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope       text NOT NULL CHECK (scope IN ('station', 'counting')),
  geo_area_id uuid REFERENCES geo_areas(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'station') = (geo_area_id IS NOT NULL))
);
CREATE UNIQUE INDEX result_agents_unique ON result_agents (tenant_id, user_id, scope, geo_area_id) NULLS NOT DISTINCT;

CREATE TABLE candidates (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code      text NOT NULL CHECK (code ~ '^[A-Z0-9]{1,4}$'),      -- the short code agents type in a text, for example A
  name      text NOT NULL,
  party     text,
  is_ours   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- Votes polled so far (a running total) at one station, as reported by an agent. Append-only: the latest by time wins and
-- every earlier value stays, with flags saying why a report needs a second look.
CREATE TABLE turnout_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  geo_area_id uuid NOT NULL REFERENCES geo_areas(id) ON DELETE CASCADE,
  agent_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  client_uuid uuid NOT NULL,                                       -- the phone's own id: sending twice never double counts
  votes_cast  int  NOT NULL CHECK (votes_cast >= 0),
  as_of       timestamptz NOT NULL,                                -- when the agent saw this number
  received_at timestamptz NOT NULL DEFAULT now(),
  channel     text NOT NULL CHECK (channel IN ('app', 'sms', 'office')),
  flags       text[] NOT NULL DEFAULT '{}',
  meta        jsonb,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, client_uuid)
);
CREATE INDEX turnout_latest ON turnout_reports (tenant_id, geo_area_id, as_of DESC, received_at DESC);

-- Votes per candidate: for one counting round (India, at the counting hall) or for one station (Canada voting places, India booth-wise).
CREATE TABLE count_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('round', 'station')),
  round_no     int CHECK (round_no IS NULL OR round_no >= 1),
  geo_area_id  uuid REFERENCES geo_areas(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  votes        int NOT NULL CHECK (votes >= 0),
  agent_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  client_uuid  uuid NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('app', 'sms', 'office')),
  as_of        timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  flags        text[] NOT NULL DEFAULT '{}',
  meta         jsonb,
  reviewed_at  timestamptz,
  reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((kind = 'round' AND round_no IS NOT NULL AND geo_area_id IS NULL) OR (kind = 'station' AND geo_area_id IS NOT NULL AND round_no IS NULL)),
  UNIQUE (tenant_id, client_uuid)
);
CREATE INDEX count_latest ON count_reports (tenant_id, kind, round_no, geo_area_id, candidate_id, as_of DESC, received_at DESC);

-- Official figures, typed in or uploaded by someone on the team from the official site. Same shape; the source is always stated.
CREATE TABLE official_counts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('round', 'station')),
  round_no     int CHECK (round_no IS NULL OR round_no >= 1),
  geo_area_id  uuid REFERENCES geo_areas(id) ON DELETE CASCADE,
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  votes        int NOT NULL CHECK (votes >= 0),
  source       text NOT NULL CHECK (source IN ('manual', 'csv')),
  source_note  text NOT NULL,                                       -- where it was read from and when, in the person's own words
  entered_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  entered_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'round' AND round_no IS NOT NULL AND geo_area_id IS NULL) OR (kind = 'station' AND geo_area_id IS NOT NULL AND round_no IS NULL))
);
CREATE INDEX official_latest ON official_counts (tenant_id, kind, round_no, geo_area_id, candidate_id, entered_at DESC);

-- A frozen copy of the results once the election is over, kept for the next one. Aggregates only: no personal data.
CREATE TABLE results_archives (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  taken_at  timestamptz NOT NULL DEFAULT now(),
  taken_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  summary   jsonb NOT NULL
);
ALTER TABLE tenants ADD COLUMN results_archived_at timestamptz;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['polling_stations', 'result_agents', 'candidates', 'turnout_reports', 'count_reports', 'official_counts', 'results_archives'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON polling_stations, result_agents, candidates TO cs_app;
-- Reports are a record: added, never edited. Only the "a person looked at this flag" columns can change.
GRANT SELECT, INSERT ON turnout_reports, count_reports, official_counts, results_archives TO cs_app;
GRANT UPDATE (reviewed_at, reviewed_by) ON turnout_reports, count_reports TO cs_app;
