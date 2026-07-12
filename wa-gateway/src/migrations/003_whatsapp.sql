-- WhatsApp send queue and per-instance throttle gate. Additive only.

CREATE TABLE IF NOT EXISTS wa_queue (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  instance    text NOT NULL,
  number      text NOT NULL,
  message     text NOT NULL,
  status      text NOT NULL DEFAULT 'QUEUED',   -- QUEUED|SENT|FAILED
  attempts    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

-- Dispatcher scans oldest queued rows per instance.
CREATE INDEX IF NOT EXISTS wa_queue_dispatch_idx
  ON wa_queue (tenant_id, instance, attempts, created_at)
  WHERE status = 'QUEUED';

-- One row per (tenant, instance): the earliest epoch-ms at which the next
-- message for that instance may be sent. Enforces the randomized gap.
CREATE TABLE IF NOT EXISTS wa_gate (
  tenant_id     text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  k             text NOT NULL,                -- instance key
  next_send_at  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, k)
);
