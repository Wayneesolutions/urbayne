-- Phase 4: stored files (receipt photos, bank statements, roll copies, audio) and bank statement reconciliation.
-- The file bytes live in object storage inside the deployment's own region (S3 in ap-south-1 or ca-central-1);
-- this table is the record of what was stored, by whom, and its checksum.

CREATE TABLE stored_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purpose       text NOT NULL CHECK (purpose IN ('receipt', 'bank_statement', 'roll_proof', 'audio')),
  storage_key   text NOT NULL,
  content_type  text NOT NULL,
  bytes         int  NOT NULL CHECK (bytes > 0),
  sha256        text NOT NULL,
  original_name text,
  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX stored_files_tenant ON stored_files (tenant_id, purpose, created_at DESC);

-- A receipt photo or PDF for an expense or contribution. One file per entry.
ALTER TABLE finance_entries ADD COLUMN receipt_file_id uuid REFERENCES stored_files(id) ON DELETE SET NULL;

-- A bank statement uploaded as CSV, to check the register against what the bank shows.
CREATE TABLE bank_statements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id     uuid REFERENCES stored_files(id) ON DELETE SET NULL,
  label       text NOT NULL,
  period_from date,
  period_to   date,
  line_count  int NOT NULL DEFAULT 0,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  statement_id     uuid NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  line_no          int  NOT NULL,
  line_date        date NOT NULL,
  description      text NOT NULL DEFAULT '',
  reference        text,
  direction        text NOT NULL CHECK (direction IN ('debit', 'credit')),      -- debit = money out, credit = money in
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  match_status     text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched', 'suggested', 'matched', 'ignored')),
  matched_entry_id uuid REFERENCES finance_entries(id) ON DELETE SET NULL,
  match_note       text,
  matched_by       uuid REFERENCES users(id) ON DELETE SET NULL,                -- null when the match was made automatically
  matched_at       timestamptz,
  UNIQUE (statement_id, line_no)
);
CREATE INDEX bank_lines_entry ON bank_lines (tenant_id, matched_entry_id) WHERE matched_entry_id IS NOT NULL;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['stored_files', 'bank_statements', 'bank_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON stored_files TO cs_app;       -- never row-deleted: deleted_at marks a removed blob
GRANT SELECT, INSERT ON bank_statements TO cs_app;
GRANT SELECT, INSERT, UPDATE ON bank_lines TO cs_app;
