-- Sign-in with email and password (replaces login by phone number and one-time code).
-- A phone number is now optional on a user: it is only used so a results agent's text message can be matched to them.

ALTER TABLE users ALTER COLUMN phone_hash DROP NOT NULL;
ALTER TABLE users ALTER COLUMN phone_enc DROP NOT NULL;

ALTER TABLE users ADD COLUMN email text CHECK (email IS NULL OR (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254));
ALTER TABLE users ADD COLUMN password_hash text;                 -- scrypt; never the password itself
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;   -- set when someone else chose the password
ALTER TABLE users ADD COLUMN is_super_admin boolean NOT NULL DEFAULT false;         -- may create and manage accounts
ALTER TABLE users ADD COLUMN disabled_at timestamptz;                               -- a disabled account cannot sign in
ALTER TABLE users ADD COLUMN last_login_at timestamptz;
CREATE UNIQUE INDEX users_email_unique ON users (email) WHERE email IS NOT NULL;

-- Someone with no phone and no email could never be found or sign in.
ALTER TABLE users ADD CONSTRAINT users_has_identity CHECK (email IS NOT NULL OR phone_hash IS NOT NULL);

-- "Forgot password" links. Only a hash of the token is stored; a token works once and for an hour.
CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user ON password_resets (user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON password_resets TO cs_app;

-- The one-time-code table is no longer used.
DROP TABLE otp_codes;
