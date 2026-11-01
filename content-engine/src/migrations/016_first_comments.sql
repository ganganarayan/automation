-- First comment: every post's link goes in its first comment. Additive only.
--
-- One row per Post for Me post. Post for Me has no first-comment option, so
-- once it reports the post live we comment on each channel ourselves, with
-- the same account token Post for Me posted with. `done` is
-- { social_account_id: { state: ok|failed|skipped, platform, error } } so a
-- channel is never commented twice.

CREATE TABLE IF NOT EXISTS first_comments (
  id                serial PRIMARY KEY,
  tenant_id         text NOT NULL DEFAULT 'default',
  postforme_post_id text NOT NULL UNIQUE,
  text              text NOT NULL,
  status            text NOT NULL DEFAULT 'pending',   -- pending | done | failed
  done              jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts          integer NOT NULL DEFAULT 0,
  next_at           timestamptz NOT NULL DEFAULT now(),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS first_comments_due_idx ON first_comments (tenant_id, status, next_at);
