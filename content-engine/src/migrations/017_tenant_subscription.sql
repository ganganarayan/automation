-- Tenant subscription details for the super admin's Tenants list. Additive only.
--
-- owner_email / phone: the customer's contact.
-- subscribed_at: when the subscription started (defaults to when the tenant was made).
-- expires_at: NULL = no expiry; the super admin extends it from the Tenants list.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS owner_email    text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone          text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscribed_at  timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS expires_at     timestamptz;

UPDATE tenants SET subscribed_at = created_at WHERE subscribed_at IS NULL;

-- The operator's own tenant.
UPDATE tenants SET owner_email = 'ganganarayan.rns@gmail.com'
 WHERE id = 'default' AND owner_email IS NULL;
