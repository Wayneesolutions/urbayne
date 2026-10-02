-- Super Admin is intentionally NOT in this schema (env-only).

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'STAFF', 'VIEWER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid,                          -- FK added below (circular with companies)
  role                 user_role NOT NULL,
  name                 text NOT NULL,
  email                text NOT NULL UNIQUE,          -- stored lowercased; globally unique
  phone                text,
  password_hash        text NOT NULL,
  permissions          jsonb,                         -- NULL = use role defaults; array = explicit override
  is_active            boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  token_version        integer NOT NULL DEFAULT 0,    -- bump to kill all existing sessions
  created_via          text NOT NULL DEFAULT 'SELF',  -- SELF | SUPER_ADMIN | OWNER
  created_by           uuid,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Only an Owner may exist without a company (between signup and company creation).
  CONSTRAINT non_owner_needs_company CHECK (role = 'OWNER' OR company_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,  -- one Owner -> one Company
  name        text NOT NULL,
  legal_name  text,
  email       text,
  phone       text,
  website     text,
  address     text,
  city        text,
  region      text,
  country     text,
  logo_url    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_company_fk
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- one Company -> exactly one Owner row
CREATE UNIQUE INDEX IF NOT EXISTS one_owner_per_company ON users(company_id) WHERE role = 'OWNER';
CREATE INDEX IF NOT EXISTS users_company_idx ON users(company_id);
