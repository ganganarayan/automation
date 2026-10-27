/**
 * captured_leads data access.
 *
 * Purpose:      Persist and read the leads captured from matching comments.
 * Responsibility: The only place captured_leads SQL runs. The insert is the
 *               idempotency gate: a duplicate comment_id can never create a
 *               second row (and therefore never a second DM).
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/**
 * Insert a lead only if its comment_id is new. Returns the created row, or null
 * when the comment was already captured (ON CONFLICT DO NOTHING). Callers treat
 * null as "already handled — stop here".
 */
export async function insertIfNew({
  tenantId = 'default',
  ruleId = null,
  platform,
  commentId,
  accountId = null,
  postId = null,
  keyword = null,
  lane = null,
  commenterId = null,
  commenterUsername = null,
  commentText = null,
  commentCreatedAt = null,
  abuse = false,
  dmStatus = 'pending',
  publicReplyStatus = 'pending',
  error = null,
}) {
  const { rows } = await query(
    `INSERT INTO captured_leads
       (tenant_id, rule_id, platform, comment_id, account_id, post_id, keyword, lane,
        commenter_id, commenter_username, comment_text, comment_created_at,
        abuse, dm_status, public_reply_status, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (comment_id) DO NOTHING
     RETURNING *`,
    [
      tenantId, ruleId, platform, commentId, accountId, postId, keyword, lane,
      commenterId, commenterUsername, commentText, commentCreatedAt,
      abuse, dmStatus, publicReplyStatus, error,
    ],
  );
  return rows[0] || null;
}

/** Patch status fields on a lead after the DM / public reply attempt. */
export async function updateStatus(id, { dmStatus, dmSentAt, publicReplyStatus, error } = {}) {
  const sets = [];
  const params = [id];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (dmStatus !== undefined) add('dm_status', dmStatus);
  if (dmSentAt !== undefined) add('dm_sent_at', dmSentAt);
  if (publicReplyStatus !== undefined) add('public_reply_status', publicReplyStatus);
  if (error !== undefined) add('error', error);
  if (!sets.length) return;
  await query(`UPDATE captured_leads SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
}

export async function get(id) {
  const { rows } = await query('SELECT * FROM captured_leads WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function getByCommentId(commentId) {
  const { rows } = await query('SELECT * FROM captured_leads WHERE comment_id = $1', [commentId]);
  return rows[0] || null;
}

/** Leads for the admin table, newest first. */
export async function listByTenant({ tenantId = 'default', limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT * FROM captured_leads WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

/** Delete one lead row (admin). Returns the deleted row so the caller can also
 *  delete the live comment on the platform. */
export async function remove(id) {
  const { rows } = await query('DELETE FROM captured_leads WHERE id = $1 RETURNING *', [id]);
  return rows[0] || null;
}

export default { insertIfNew, updateStatus, get, getByCommentId, listByTenant, remove };
