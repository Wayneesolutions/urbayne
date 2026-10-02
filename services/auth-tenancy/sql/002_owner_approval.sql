-- Self-registered Owners start PENDING and cannot log in until the Super Admin approves them.
-- Existing rows, Super-Admin-created Owners and company users are APPROVED.
ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'APPROVED';
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejection_reason text;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_approval_status_check
    CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS users_pending_owners_idx ON users(created_at) WHERE role = 'OWNER' AND approval_status = 'PENDING';
