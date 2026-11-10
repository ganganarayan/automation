-- Paid provider calls that belong to no run (an image-gate test, for example),
-- so a tenant's monthly cost adds up. Calls inside a run keep their cost on the
-- run's steps, as before. key_owner: 'platform' (the owner's key, on the owner's
-- bill) or 'tenant' (the tenant's own key). Additive only.

CREATE TABLE IF NOT EXISTS usage_ledger (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  provider    text NOT NULL,
  model       text,
  unit        text,
  quantity    numeric(14,4) NOT NULL DEFAULT 0,
  cost_usd    numeric(12,6) NOT NULL DEFAULT 0,
  source      text NOT NULL DEFAULT '',
  key_owner   text NOT NULL DEFAULT 'platform',
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_ledger_tenant_at_idx ON usage_ledger (tenant_id, at DESC);
