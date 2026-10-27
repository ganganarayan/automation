-- Comment-to-DM capture layer: keyword rules per published post, and the leads
-- captured when someone comments a matching keyword. Instagram + Facebook Pages
-- only (the only platforms with a private-reply / messaging API). Additive only.

-- One rule per (post, keyword). platform_post_id is the NATIVE id Meta's comment
-- webhook carries (IG media id / FB post id) and is the match key; the Post-for-Me
-- id is kept as the publish anchor so a post can always be traced back.
CREATE TABLE IF NOT EXISTS keyword_rules (
  id                    bigserial PRIMARY KEY,
  tenant_id             text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  funnel_id             bigint REFERENCES funnels(id) ON DELETE SET NULL,
  platform              text NOT NULL,                  -- instagram | facebook
  platform_post_id      text NOT NULL,                  -- native IG media / FB post id (match key)
  postforme_post_id     text,                           -- Post-for-Me social-post id (publish anchor)
  lane                  text,                           -- free label (funnel / campaign)
  keyword               text NOT NULL,
  match_mode            text NOT NULL DEFAULT 'word',   -- word | contains
  dm_text               text NOT NULL DEFAULT '',
  dm_link               text,
  public_reply_variants jsonb NOT NULL DEFAULT '[]'::jsonb,  -- array of strings, picked at random
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, platform_post_id, keyword)         -- publish-time create is idempotent
);

CREATE INDEX IF NOT EXISTS keyword_rules_match_idx
  ON keyword_rules (tenant_id, platform_post_id, active);

-- One row per comment we saw. comment_id is globally unique so a duplicate
-- webhook can never insert twice -> never a second DM (idempotency lives here).
CREATE TABLE IF NOT EXISTS captured_leads (
  id                   bigserial PRIMARY KEY,
  tenant_id            text NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  rule_id              bigint REFERENCES keyword_rules(id) ON DELETE SET NULL,
  platform             text NOT NULL,
  comment_id           text NOT NULL UNIQUE,            -- idempotency key
  post_id              text,                            -- native post id
  keyword              text,
  lane                 text,
  commenter_id         text,
  commenter_username   text,
  comment_text         text,
  comment_created_at   timestamptz,                     -- when Meta says the comment was CREATED
  abuse                boolean NOT NULL DEFAULT false,  -- flagged by the abuse filter (no DM)
  dm_status            text NOT NULL DEFAULT 'pending',
                       -- pending | sent | skipped_old | skipped_window | blocked_abuse | failed | no_rule | self
  dm_sent_at           timestamptz,
  public_reply_status  text NOT NULL DEFAULT 'pending', -- pending | done | skipped | failed
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS captured_leads_recent_idx ON captured_leads (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS captured_leads_post_idx   ON captured_leads (tenant_id, post_id);
