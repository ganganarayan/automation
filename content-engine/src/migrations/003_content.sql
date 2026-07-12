-- content-engine owned tables: delivery log, approvals, refill state.
-- Additive only.

CREATE TABLE IF NOT EXISTS pfm_delivery_log (
  id            bigserial PRIMARY KEY,
  tenant_id     text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  brand         text,
  account_id    text,
  post_id       text,
  platform      text,
  account_name  text,
  success       boolean NOT NULL DEFAULT false,
  error         text,
  day_ist       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pfm_delivery_day_idx ON pfm_delivery_log (tenant_id, brand, day_ist);
CREATE INDEX IF NOT EXISTS pfm_delivery_post_idx ON pfm_delivery_log (tenant_id, post_id);

CREATE TABLE IF NOT EXISTS approvals (
  id           uuid PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  kind         text NOT NULL,                 -- gita_image | vidapulse_image | video | video_simple
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending', -- pending|approved|rework|expired|published
  note         text,
  token_used   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals (tenant_id, kind, status);

CREATE TABLE IF NOT EXISTS refill_state (
  tenant_id    text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  brand        text NOT NULL,
  refill_sent  boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, brand)
);
