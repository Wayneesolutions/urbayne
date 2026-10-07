-- Phase 4: households imported from electoral roll copies the candidate legally receives (CSV or Excel, with the original as proof).
-- Only the household is kept: house number, address text and how many electors live there. Names, ages, relatives' names and
-- anything about caste or religion are never stored. Rows are deleted with the rest of the personal data after the election.

CREATE TABLE roll_imports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  geo_area_id        uuid NOT NULL REFERENCES geo_areas(id) ON DELETE CASCADE,
  proof_file_id      uuid NOT NULL REFERENCES stored_files(id),            -- the roll copy itself, kept as proof of where the list came from
  source_kind        text NOT NULL CHECK (source_kind IN ('electoral_roll_copy', 'other_legal_list')),
  source_description text NOT NULL CHECK (length(source_description) >= 10),  -- who gave it, when, under what entitlement
  format             text NOT NULL CHECK (format IN ('csv', 'xlsx', 'rows')),
  rows_total         int NOT NULL,
  rows_imported      int NOT NULL,
  rows_duplicate     int NOT NULL DEFAULT 0,
  rows_rejected      int NOT NULL DEFAULT 0,
  ignored_columns    text[] NOT NULL DEFAULT '{}',
  imported_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE households (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  geo_area_id    uuid NOT NULL REFERENCES geo_areas(id) ON DELETE CASCADE,
  roll_import_id uuid NOT NULL REFERENCES roll_imports(id) ON DELETE CASCADE,
  house_no       text NOT NULL,
  address        text,
  electors       int CHECK (electors IS NULL OR electors >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, geo_area_id, house_no)
);
CREATE INDEX households_area ON households (tenant_id, geo_area_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['roll_imports', 'households'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, DELETE ON roll_imports, households TO cs_app;
GRANT UPDATE (rows_imported, rows_duplicate) ON roll_imports TO cs_app;
