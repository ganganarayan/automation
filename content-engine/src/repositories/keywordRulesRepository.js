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
 * Create (or idempotently update) a rule at publish, keyed by the Post-for-Me
 * post id + platform + keyword. The native platform_post_id and account_id are
 * left NULL here and learned from the first matching comment (bindNativePost).
 * A re-publish of the same Post-for-Me post updates the same row.
 */
export async function upsert({
  tenantId = 'default',
  funnelId = null,
  platform,
  platformPostId = null,
  accountId = null,
  postformePostId = null,
  lane = null,
  keyword,
  matchMode = 'word',
  dmText = '',
  dmLink = null,
  publicReplyVariants = [],
  requireFollow = false,
  followupText = null,
  notFollowingText = null,
  active = true,
}) {
  const { rows } = await query(
    `INSERT INTO keyword_rules
       (tenant_id, funnel_id, platform, platform_post_id, account_id, postforme_post_id, lane,
        keyword, match_mode, dm_text, dm_link, public_reply_variants, active,
        require_follow, followup_text, not_following_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)
     ON CONFLICT (tenant_id, postforme_post_id, platform, keyword) DO UPDATE SET
       funnel_id = EXCLUDED.funnel_id,
       lane = EXCLUDED.lane,
       match_mode = EXCLUDED.match_mode,
       dm_text = EXCLUDED.dm_text,
       dm_link = EXCLUDED.dm_link,
       public_reply_variants = EXCLUDED.public_reply_variants,
       active = EXCLUDED.active,
       require_follow = EXCLUDED.require_follow,
       followup_text = EXCLUDED.followup_text,
       not_following_text = EXCLUDED.not_following_text,
       updated_at = now()
     RETURNING *`,
    [
      tenantId, funnelId, platform, platformPostId, accountId, postformePostId, lane,
      keyword, matchMode, dmText, dmLink, JSON.stringify(publicReplyVariants || []), active,
      !!requireFollow, followupText, notFollowingText,
    ],
  );
  return rows[0];
}

/** Active rules already bound to a given native post (direct match). */
export async function activeForPost({ tenantId = 'default', platformPostId }) {
  if (!platformPostId) return [];
  const { rows } = await query(
    `SELECT * FROM keyword_rules
      WHERE tenant_id = $1 AND platform_post_id = $2 AND active = true`,
    [tenantId, platformPostId],
  );
  return rows;
}

/** Active rules for a platform not yet bound to a native post, newest first.
 *  Used to learn the native post id from the first matching comment. */
export async function activeUnlinkedForPlatform({ tenantId = 'default', platform }) {
  const { rows } = await query(
    `SELECT * FROM keyword_rules
      WHERE tenant_id = $1 AND platform = $2 AND active = true AND platform_post_id IS NULL
      ORDER BY created_at DESC`,
    [tenantId, platform],
  );
  return rows;
}

/** Bind a rule to the native post + account learned from a comment (once). */
export async function bindNativePost({ ruleId, platformPostId, accountId = null }) {
  await query(
    `UPDATE keyword_rules
        SET platform_post_id = $2, account_id = COALESCE($3, account_id), updated_at = now()
      WHERE id = $1 AND platform_post_id IS NULL`,
    [ruleId, platformPostId, accountId],
  );
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

export default { upsert, activeForPost, activeUnlinkedForPlatform, bindNativePost, listByTenant, get, setActive };
