-- Per-funnel and per-client pricing. Additive only.
--
-- tenants.units: funnels (Always-On Brand) or clients (Agency) bought; NULL keeps
--   the plan's flat limits (workspaces set up before this).
-- tenants.extra_users: users bought on top of the plan's own.
-- checkouts.units / extra_users: what the buyer picked on the buy page.

ALTER TABLE tenants   ADD COLUMN IF NOT EXISTS units       integer;
ALTER TABLE tenants   ADD COLUMN IF NOT EXISTS extra_users integer NOT NULL DEFAULT 0;
ALTER TABLE checkouts ADD COLUMN IF NOT EXISTS units       integer NOT NULL DEFAULT 1;
ALTER TABLE checkouts ADD COLUMN IF NOT EXISTS extra_users integer NOT NULL DEFAULT 0;
