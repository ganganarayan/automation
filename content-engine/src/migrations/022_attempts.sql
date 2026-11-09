-- Disapproved attempts: each Remake moves the turned-down attempt, with its real
-- cost and its own start and end time, into deleted_instances, linked to the run
-- it came from (run_id) and numbered (attempt). Additive only.

ALTER TABLE deleted_instances ADD COLUMN IF NOT EXISTS run_id uuid;
ALTER TABLE deleted_instances ADD COLUMN IF NOT EXISTS attempt integer;

CREATE INDEX IF NOT EXISTS deleted_instances_run_idx ON deleted_instances (run_id);
