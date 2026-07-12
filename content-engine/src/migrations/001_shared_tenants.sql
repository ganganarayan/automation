-- Shared tenancy tables. Created if absent by whichever service boots first;
-- safe for all services to attempt (IF NOT EXISTS). Additive only.

CREATE TABLE IF NOT EXISTS tenants (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, name, status)
VALUES ('default', 'Default Tenant', 'active')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenant_config (
  tenant_id   text NOT NULL REFERENCES tenants(id),
  key         text NOT NULL,
  value       text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
