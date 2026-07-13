-- Funnels: a tenant's brand/campaign scopes (e.g. "Gita", "Divine Leads").
-- Each funnel owns its own content source, publishing accounts, style, and
-- schedule. The daily poster runs once per active funnel. Additive only.

CREATE TABLE IF NOT EXISTS funnels (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  name        text NOT NULL,
  style       text NOT NULL DEFAULT 'band',   -- band | strip | plain
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS funnels_active_idx ON funnels (tenant_id, active);

-- Per-funnel configuration (sheet id, drive folder, PostForMe key + accounts,
-- approval email, CTA link, publish time, ...).
CREATE TABLE IF NOT EXISTS funnel_config (
  funnel_id   bigint NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  key         text NOT NULL,
  value       text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (funnel_id, key)
);
