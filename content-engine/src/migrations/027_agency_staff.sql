-- Agency staff (docs/agency-build-plan.md, phase 3). Additive only.
--
-- users.tenant_role: what a person is in their home workspace. 'admin' (every
-- existing user) reaches every client of an Agency home workspace; 'staff'
-- reaches only the clients listed for them in tenant_members (role 'staff').
-- Phase 4 adds the client roles.

ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_role text NOT NULL DEFAULT 'admin';
