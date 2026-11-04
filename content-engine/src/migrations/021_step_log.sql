-- Step log: one instance's step starts and ends in time order, so the Library can
-- show the step it is on and the working time per step. The steps column only keeps
-- the last start and end of each stage and knows nothing about approval waits.
-- Additive only: rows from before this start empty and fall back to the steps column.

ALTER TABLE instances ADD COLUMN IF NOT EXISTS step_log jsonb NOT NULL DEFAULT '[]'::jsonb;
