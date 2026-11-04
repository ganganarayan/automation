-- Deleted instances: a permanent log, so the money spent on a run still adds up
-- after the run is gone. Nothing restores from here. No foreign key on funnel_id:
-- a log row must outlive its funnel. Additive only.

CREATE TABLE IF NOT EXISTS deleted_instances (
  id          uuid PRIMARY KEY,
  tenant_id   text NOT NULL DEFAULT 'default',
  funnel_id   bigint,
  funnel_name text NOT NULL DEFAULT '',
  title       text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT '',            -- what it was when deleted
  cost_usd    numeric(10,4) NOT NULL DEFAULT 0,
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- for the per-step cost breakdown
  created_at  timestamptz NOT NULL,
  deleted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deleted_instances_tenant_idx ON deleted_instances (tenant_id, deleted_at DESC);
