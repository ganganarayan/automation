-- Instances: one runtime execution of a funnel's video pipeline. Each run has
-- its own instance_id and accumulates per-step artifacts and REAL per-step AI
-- costs. It is a read-only review record: generation fills it, two checkpoints
-- (script, final) gate it, and approval locks it into the posted log. Additive.

CREATE TABLE IF NOT EXISTS instances (
  id               uuid PRIMARY KEY,
  tenant_id        text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  funnel_id        bigint REFERENCES funnels(id) ON DELETE SET NULL,
  funnel_name      text NOT NULL DEFAULT '',        -- snapshot (survives rename)
  title            text NOT NULL DEFAULT '',        -- the video title
  status           text NOT NULL DEFAULT 'script_review',
                   -- script_review | running | final_review | approved
                   -- | posted | failed | superseded
  locked           boolean NOT NULL DEFAULT false,  -- true once posted; blocks edits
  duration_seconds integer,                         -- final reel length
  cost_usd         numeric(10,4) NOT NULL DEFAULT 0,-- denormalized sum of step costs
  steps            jsonb NOT NULL DEFAULT '[]'::jsonb,
                   -- [{ key,label,status,artifacts,costs:[{provider,model,unit,
                   --    quantity,unitPriceUsd,costUsd,at}],startedAt,finishedAt,error }]
  note             text,                            -- latest reject/correction note
  round            integer NOT NULL DEFAULT 1,      -- rework round
  post_status      text NOT NULL DEFAULT 'pending', -- pending | scheduled | posted | failed
  post_refs        jsonb NOT NULL DEFAULT '[]'::jsonb,
  scheduled_for    timestamptz,                     -- when it must post (cron plans back from this)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  approved_at      timestamptz,
  posted_at        timestamptz
);

CREATE INDEX IF NOT EXISTS instances_tenant_status_idx ON instances (tenant_id, status);
CREATE INDEX IF NOT EXISTS instances_funnel_idx ON instances (funnel_id);
CREATE INDEX IF NOT EXISTS instances_posted_idx ON instances (tenant_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS instances_scheduled_idx ON instances (scheduled_for);
