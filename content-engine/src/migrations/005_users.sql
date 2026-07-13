-- Users, roles, plans, and billing history (self-signup model).
-- Owned by content-engine. Additive only.
--
-- role: 'user' (default for signups) | 'admin' | 'super_admin'.
-- plan_ends_at: NULL = forever, else the plan end date.
-- last_login_at: set by the (future) sign-in flow.
-- Password/login and billing integration are added later; this stores the model.

CREATE TABLE IF NOT EXISTS users (
  email          text PRIMARY KEY,
  role           text NOT NULL DEFAULT 'user',
  plan_ends_at   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Seed / enforce the super admin (the operator).
INSERT INTO users (email, role)
VALUES ('ganganarayan.rns@gmail.com', 'super_admin')
ON CONFLICT (email) DO UPDATE SET role = 'super_admin';

CREATE TABLE IF NOT EXISTS billing_history (
  id           bigserial PRIMARY KEY,
  user_email   text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  description  text,
  amount_inr   numeric(12,2),
  status       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_history_user_idx ON billing_history (user_email, occurred_at DESC);
