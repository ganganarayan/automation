/**
 * jobs data access.
 *
 * Purpose:      Persist and claim generic managed jobs.
 * Responsibility: The only place jobs SQL runs. Claiming uses an atomic
 *               UPDATE ... RETURNING so concurrent workers cannot double-claim.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/** Enqueue a job. runAt is a Date (defaults to now). */
export async function create({ tenantId = 'default', type, payload = {}, runAt }) {
  const { rows } = await query(
    `INSERT INTO jobs (tenant_id, type, payload, next_run)
     VALUES ($1, $2, $3, COALESCE($4, now()))
     RETURNING *`,
    [tenantId, type, payload, runAt || null],
  );
  return rows[0];
}

/**
 * Atomically claim up to `limit` due pending jobs of the given types.
 * Marks them running and returns them.
 */
export async function claimDue({ types, limit = 5 }) {
  const { rows } = await query(
    `UPDATE jobs SET status = 'running', started_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = 'pending' AND next_run <= now() AND type = ANY($1)
         ORDER BY next_run ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [types, limit],
  );
  return rows;
}

/** Mark a claimed job done. */
export async function markDone(id) {
  await query(
    `UPDATE jobs SET status = 'done', finished_at = now(), error = NULL, updated_at = now() WHERE id = $1`,
    [id],
  );
}

/**
 * Mark a job failed. If attempts remain, requeue as pending with a backoff
 * next_run; otherwise leave it failed.
 */
export async function markFailed(id, { error, retry = false, backoffSeconds = 60 }) {
  if (retry) {
    await query(
      `UPDATE jobs
          SET status = 'pending', error = $2,
              next_run = now() + ($3 || ' seconds')::interval, updated_at = now()
        WHERE id = $1`,
      [id, String(error).slice(0, 1000), backoffSeconds],
    );
  } else {
    await query(
      `UPDATE jobs SET status = 'failed', finished_at = now(), error = $2, updated_at = now() WHERE id = $1`,
      [id, String(error).slice(0, 1000)],
    );
  }
}

/** Recent jobs (admin view). */
export async function recent({ tenantId, limit = 100 }) {
  const params = [];
  let where = '';
  if (tenantId) {
    params.push(tenantId);
    where = 'WHERE tenant_id = $1';
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT id, tenant_id, type, status, attempts, next_run, started_at, finished_at, error, created_at
       FROM jobs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export default { create, claimDue, markDone, markFailed, recent };
