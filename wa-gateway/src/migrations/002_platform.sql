-- Platform tables owned by this service: generic managed jobs and event log.
-- Additive only.

CREATE TABLE IF NOT EXISTS jobs (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending',   -- pending|running|done|failed
  attempts     int NOT NULL DEFAULT 0,
  next_run     timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (status, next_run)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS event_log (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  service     text NOT NULL,
  event_type  text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_log_type_idx ON event_log (tenant_id, event_type, created_at DESC);
