-- Publishing goes through Post-for-Me, which returns its OWN post id, not the
-- native Instagram media / Facebook post id that Meta's comment webhook carries.
-- So a rule is created at publish keyed by (postforme_post_id, platform, keyword)
-- with the native platform_post_id left NULL, and the native id is learned from
-- the first matching comment (which carries it). Relax the old native-id identity.

ALTER TABLE keyword_rules ALTER COLUMN platform_post_id DROP NOT NULL;

-- Drop the old inline UNIQUE (tenant_id, platform_post_id, keyword).
ALTER TABLE keyword_rules DROP CONSTRAINT IF EXISTS keyword_rules_tenant_id_platform_post_id_keyword_key;

-- Publish-time identity: one rule per Post-for-Me post, per platform, per keyword.
CREATE UNIQUE INDEX IF NOT EXISTS keyword_rules_publish_idx
  ON keyword_rules (tenant_id, postforme_post_id, platform, keyword);
