-- Daily post router (docs/daily-router-plan.md). Each afternoon the router
-- decides, per funnel, which lane delivers TOMORROW's post and records it here:
-- one row per funnel per IST post date, so a second ping never decides twice.
-- The admin "Today → Tomorrow by funnel" list reads this table. Additive only.
--
--   post_date:   the IST date the post goes out
--   lane:        ready_video | ai_video | image | none
--   reason:      why ('already scheduled', 'image lane', the error, ...)
--   instance_id: the instance that delivers it (null for 'none')
--
-- The funnel's landing page link (router research input) is a funnel_config
-- key, landing_page_url, like every other funnel setting: no DDL needed.

CREATE TABLE IF NOT EXISTS router_days (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  funnel_id    bigint NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  post_date    date NOT NULL,
  lane         text NOT NULL,
  reason       text NOT NULL DEFAULT '',
  instance_id  uuid REFERENCES instances(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (funnel_id, post_date)
);

CREATE INDEX IF NOT EXISTS router_days_tenant_date_idx ON router_days (tenant_id, post_date);
