-- Delay Relay lead intake queue and per-account ramp/destination config.
-- Additive only.

CREATE TABLE IF NOT EXISTS contact_queue (
  id             bigserial PRIMARY KEY,
  tenant_id      text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  account        text NOT NULL,
  contact_name   text,
  contact_email  text,
  contact_phone  text,
  status         text NOT NULL DEFAULT 'pending',  -- pending|sent|failed|invalid
  channels       text,                              -- comma list: email,whatsapp
  invalid_reason text,
  received_at    timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);

CREATE INDEX IF NOT EXISTS contact_queue_pick_idx
  ON contact_queue (tenant_id, account, received_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS relay_control (
  tenant_id       text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  account         text NOT NULL,
  daily_limit     int NOT NULL DEFAULT 300,
  ramp_base       int NOT NULL DEFAULT 30,
  ramp_step       int NOT NULL DEFAULT 30,
  warmup_days     int NOT NULL DEFAULT 5,
  ramp_day        int NOT NULL DEFAULT 0,
  last_qty        int NOT NULL DEFAULT 0,
  min_seconds     int NOT NULL DEFAULT 120,
  max_seconds     int NOT NULL DEFAULT 300,
  destination_url text,
  log_sheet_id    text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account)
);
