-- Email + password sign-in. Additive only.
--
-- A user with no password_hash has never signed in: the first sign-in is
-- proven another way (the legacy access key, or the reset code) and then
-- forced to choose a password. must_change_password keeps that popup up until
-- a password is set.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash         text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password  boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at   timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins         integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until          timestamptz;

-- One row per signed-in browser. The cookie holds a random token; only its
-- sha256 is stored, so a database leak cannot be replayed as a session.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash    text PRIMARY KEY,
  email         text NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  must_change   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_sessions_email_idx ON auth_sessions (email);

-- Enforce the super admin (the operator) in every environment.
INSERT INTO users (email, role)
VALUES ('ganganarayan.rns@gmail.com', 'super_admin')
ON CONFLICT (email) DO UPDATE SET role = 'super_admin';
