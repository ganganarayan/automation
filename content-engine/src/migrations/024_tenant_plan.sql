-- A tenant's plan (docs/pricing-plan.md): starter | growth | agency | custom.
-- custom has no limits; every existing tenant (the owner's included) starts
-- there so nothing changes until the super admin picks a plan. Additive only.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'custom';
