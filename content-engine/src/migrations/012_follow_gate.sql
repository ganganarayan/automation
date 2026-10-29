-- Follow gate. Meta only grants profile consent once a person MESSAGES the
-- business, so follower status cannot be read at comment time — only when they
-- reply to our first DM (which is also when the 24h window opens). The reply
-- then branches: followers get the delivery, non-followers get a nudge.
-- Instagram only; Facebook removed the page-follow check in Graph API v2.2.
-- Additive only.

ALTER TABLE keyword_rules ADD COLUMN IF NOT EXISTS require_follow      boolean NOT NULL DEFAULT false;
ALTER TABLE keyword_rules ADD COLUMN IF NOT EXISTS followup_text       text;   -- sent when they qualify
ALTER TABLE keyword_rules ADD COLUMN IF NOT EXISTS not_following_text  text;   -- sent when they don't follow

-- One follow-up per lead: 'pending' is claimed atomically before any send.
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS followup_status text NOT NULL DEFAULT 'pending';
       -- pending | running | delivered | nudged | skipped | failed
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS follows     boolean;        -- null = unknown/not checked
ALTER TABLE captured_leads ADD COLUMN IF NOT EXISTS replied_at  timestamptz;

CREATE INDEX IF NOT EXISTS captured_leads_followup_idx
  ON captured_leads (tenant_id, account_id, commenter_id, followup_status);
