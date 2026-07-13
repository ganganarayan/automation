-- Admin identities and roles (managed via the Access screen, not env vars).
-- Owned by content-engine. Additive only.
--
-- role: 'super_admin' (spans all tenants) | 'admin' (scoped to tenant_id).
-- Password/login is intentionally not modelled yet — this stores identities and
-- roles now; authentication is added later.

CREATE TABLE IF NOT EXISTS admins (
  email       text PRIMARY KEY,
  role        text NOT NULL DEFAULT 'admin',
  tenant_id   text,                       -- NULL for super_admin (all tenants)
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed / enforce the super admin.
INSERT INTO admins (email, role, tenant_id)
VALUES ('ganganarayan.rns@gmail.com', 'super_admin', NULL)
ON CONFLICT (email) DO UPDATE SET role = 'super_admin', tenant_id = NULL;
