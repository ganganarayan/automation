-- Provider keys moved OUT of funnels into one central store (tenant_config —
-- the "API Keys" page). A funnel now only chooses which provider/model to use.
--
-- Carry over anything a funnel already held so existing setups keep working with
-- nothing re-entered. Most-recently-updated funnel value wins; an existing
-- tenant value is never overwritten. Additive and idempotent.

INSERT INTO tenant_config (tenant_id, key, value, updated_at)
SELECT DISTINCT ON (f.tenant_id, fc.key)
       f.tenant_id, fc.key, fc.value, now()
  FROM funnel_config fc
  JOIN funnels f ON f.id = fc.funnel_id
 WHERE fc.key IN ('postforme_api_key', 'kling_access_key', 'kling_secret_key',
                  'runway_api_key', 'hailuo_api_key', 'hailuo_group_id',
                  'transcript_api_key')
   AND COALESCE(fc.value, '') <> ''
 ORDER BY f.tenant_id, fc.key, fc.updated_at DESC
ON CONFLICT (tenant_id, key) DO NOTHING;

-- The per-funnel clone key becomes the central ElevenLabs key (the default clone
-- provider). A HeyGen user pastes theirs on the API Keys page.
INSERT INTO tenant_config (tenant_id, key, value, updated_at)
SELECT DISTINCT ON (f.tenant_id)
       f.tenant_id, 'elevenlabs_api_key', fc.value, now()
  FROM funnel_config fc
  JOIN funnels f ON f.id = fc.funnel_id
 WHERE fc.key = 'tts_api_key' AND COALESCE(fc.value, '') <> ''
 ORDER BY f.tenant_id, fc.updated_at DESC
ON CONFLICT (tenant_id, key) DO NOTHING;
