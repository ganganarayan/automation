/**
 * keyword_rules data access.
 *
 * Purpose:      Persist and read the per-post keyword rules that drive the
 *               comment-to-DM capture layer.
 * Responsibility: The only place keyword_rules SQL runs.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/**
 * Create (or idempotently update) a rule for a post+keyword. Publish-time rule
 * creation calls this; a re-publish of the same post updates the same row rather
 * than making a duplicate (UNIQUE tenant_id, platform_post_id, keyword).
 */
export async function upsert({
  tenantId = 'default',
  funnelId = null,
  platform,
  platformPostId,
  postformePostId = null,
  lane = null,
  keyword,
  matchMode = 'word',
  dmText = '',
  dmLink = null,
  publicReplyVariants = [],
  active = true,
}) {
  const { rows } = await query(
    `INSERT INTO keyword_rules
       (tenant_id, funnel_id, platform, platform_post_id, postforme_post_id, lane,
        keyword, match_mode, dm_text, dm_link, public_reply_variants, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
     ON CONFLICT (tenant_id, platform_post_id, keyword) DO UPDATE SET
       funnel_id = EXCLUDED.funnel_id,
       platform = EXCLUDED.platform,
       postforme_post_id = COALESCE(EXCLUDED.postforme_post_id, keyword_rules.postforme_post_id),
       lane = EXCLUDED.lane,
       match_mode = EXCLUDED.match_mode,
       dm_text = EXCLUDED.dm_text,
       dm_link = EXCLUDED.dm_link,
       public_reply_variants = EXCLUDED.public_reply_variants,
       active = EXCLUDED.active,
       updated_at = now()
     RETURNING *`,
    [
      tenantId, funnelId, platform, platformPostId, postformePostId, lane,
      keyword, matchMode, dmText, dmLink, JSON.stringify(publicReplyVariants || []), active,
    ],
  );
  return rows[0];
}

/** Active rules for a given post (the match set a comment is tested against). */
export async function activeForPost({ tenantId = 'default', platformPostId }) {
  const { rows } = await query(
    `SELECT * FROM keyword_rules
      WHERE tenant_id = $1 AND platform_post_id = $2 AND active = true`,
    [tenantId, platformPostId],
  );
  return rows;
}

/** All rules for the admin list, newest first. */
export async function listByTenant({ tenantId = 'default', limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT * FROM keyword_rules WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

export async function get(id) {
  const { rows } = await query('SELECT * FROM keyword_rules WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Flip a rule on/off (admin toggle). */
export async function setActive(id, active) {
  await query('UPDATE keyword_rules SET active = $2, updated_at = now() WHERE id = $1', [id, !!active]);
}

export default { upsert, activeForPost, listByTenant, get, setActive };
