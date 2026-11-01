/**
 * first_comments data access.
 *
 * Purpose:      The queue of "put this post's link in its first comment" jobs,
 *               one per Post for Me post.
 * Responsibility: The only place first_comments SQL runs.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/** Queue a post (idempotent: the same Post for Me post is queued once). */
export async function enqueue({ tenantId = 'default', postformePostId, text, nextAt = null }) {
  const { rows } = await query(
    `INSERT INTO first_comments (tenant_id, postforme_post_id, text, next_at)
     VALUES ($1, $2, $3, COALESCE($4, now()))
     ON CONFLICT (postforme_post_id) DO NOTHING
     RETURNING *`,
    [tenantId, postformePostId, text, nextAt],
  );
  return rows[0] || null;
}

/** Pending jobs whose next check is due. */
export async function due(tenantId = 'default', limit = 25) {
  const { rows } = await query(
    `SELECT * FROM first_comments
      WHERE tenant_id = $1 AND status = 'pending' AND next_at <= now()
      ORDER BY next_at LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

export async function getByPost(postformePostId) {
  const { rows } = await query('SELECT * FROM first_comments WHERE postforme_post_id = $1', [postformePostId]);
  return rows[0] || null;
}

/**
 * Claim one channel before commenting (the webhook and the timer can race):
 * true only for the caller that marked it 'sending'.
 */
export async function claim(id, accountId) {
  const { rows } = await query(
    `UPDATE first_comments SET done = done || jsonb_build_object($2::text, '{"state":"sending"}'::jsonb), updated_at = now()
      WHERE id = $1 AND NOT (done ? $2::text) RETURNING id`,
    [id, accountId],
  );
  return rows.length > 0;
}

/** Record one channel's outcome ({ state, platform, error }). */
export async function mark(id, accountId, value) {
  await query(
    `UPDATE first_comments SET done = done || jsonb_build_object($2::text, $3::jsonb), updated_at = now() WHERE id = $1`,
    [id, accountId, JSON.stringify(value)],
  );
}

/** Give a claimed channel back (a retryable failure: try it on the next pass). */
export async function release(id, accountId) {
  await query(`UPDATE first_comments SET done = done - $2::text, updated_at = now() WHERE id = $1`, [id, accountId]);
}

/** Finish a pass: status, attempts, next check (per-channel results are already saved). */
export async function finish(id, { status, attempts, nextAt = null, lastError = null }) {
  await query(
    `UPDATE first_comments SET status = $2, attempts = $3, next_at = COALESCE($4, next_at), last_error = $5, updated_at = now() WHERE id = $1`,
    [id, status, attempts, nextAt, lastError],
  );
}

export default { enqueue, due, getByPost, claim, mark, release, finish };
