-- Each user belongs to one tenant (the workspace they sign in to). Existing
-- users stay on the default tenant, except a tenant's own owner_email, who
-- moves to that tenant. The super admin stays on default and may open any
-- tenant. Additive only.

ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'default' REFERENCES tenants(id);

UPDATE users u
   SET tenant_id = t.id
  FROM tenants t
 WHERE lower(t.owner_email) = lower(u.email)
   AND t.id <> 'default'
   AND u.role <> 'super_admin'
   AND u.tenant_id = 'default';

CREATE INDEX IF NOT EXISTS users_tenant_idx ON users (tenant_id);
