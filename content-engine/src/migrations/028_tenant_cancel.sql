-- One-click cancel. Additive only.
--
-- cancelled_at: when the workspace's admin pressed Cancel (NULL = renews as
-- usual). The workspace keeps working until expires_at; the super admin sees
-- the flag on Tenants and does not extend it. Keep my plan sets it back to NULL.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
