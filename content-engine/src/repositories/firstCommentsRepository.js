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

/** Save progress: per-channel results, status, the next check. */
export async function save(id, { status, done, attempts, nextAt, lastError = null }) {
  await query(
    `UPDATE first_comments
        SET status = $2, done = $3, attempts = $4, next_at = COALESCE($5, next_at), last_error = $6, updated_at = now()
      WHERE id = $1`,
    [id, status, JSON.stringify(done || {}), attempts, nextAt, lastError],
  );
}

export async function getByPost(postformePostId) {
  const { rows } = await query('SELECT * FROM first_comments WHERE postforme_post_id = $1', [postformePostId]);
  return rows[0] || null;
}

export default { enqueue, due, save, getByPost };
