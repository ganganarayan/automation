-- Run log: one row per thing that happened to an instance, to trace why anything
-- failed and how many tries it took. Kept after the instance is deleted.
--
-- pass:  1 = the first run; each Retry or Remake starts the next pass.
-- event: created | retry | remake | success | failed | disapproved | superseded |
--        retry refused | deleted
-- detail: the error for a failure, what was reached for a success, why for a delete.
CREATE TABLE IF NOT EXISTS run_log (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'default',
  instance_id  uuid NOT NULL,
  title        text NOT NULL DEFAULT '',
  funnel_name  text NOT NULL DEFAULT '',
  pass         integer NOT NULL DEFAULT 1,
  event        text NOT NULL,
  detail       text NOT NULL DEFAULT '',
  by_email     text NOT NULL DEFAULT '',
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_log_instance ON run_log (instance_id, at);
CREATE INDEX IF NOT EXISTS run_log_tenant_at ON run_log (tenant_id, at DESC);
