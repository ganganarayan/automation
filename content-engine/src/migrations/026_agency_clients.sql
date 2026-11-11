-- Agency clients (docs/agency-build-plan.md, phases 1 and 2). Additive only.
--
-- A client is a tenant whose parent_id is an Agency tenant. Clients follow
-- their agency's plan and expiry; there are no grandchildren (the app checks).
-- tenant_members: extra workspaces a person may work in beside their home
-- (users.tenant_id). Agency admins also reach every client of their agency
-- without a row here.
-- auth_sessions.active_tenant_id: the workspace this browser works in (the
-- switcher); null = the home workspace.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS parent_id text REFERENCES tenants(id);
CREATE INDEX IF NOT EXISTS tenants_parent_idx ON tenants (parent_id);

CREATE TABLE IF NOT EXISTS tenant_members (
  email      text NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  tenant_id  text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'admin',
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (email, tenant_id)
);
CREATE INDEX IF NOT EXISTS tenant_members_tenant_idx ON tenant_members (tenant_id);

ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS active_tenant_id text REFERENCES tenants(id) ON DELETE SET NULL;
