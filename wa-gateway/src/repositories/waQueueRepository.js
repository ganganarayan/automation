/**
 * wa_queue data access.
 *
 * Purpose:      Persist queued WhatsApp messages and their delivery state.
 * Responsibility: The only place wa_queue SQL runs.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/** Insert a queued message. */
export async function enqueue({ tenantId = 'default', instance, number, message }) {
  const { rows } = await query(
    `INSERT INTO wa_queue (tenant_id, instance, number, message, status)
     VALUES ($1, $2, $3, $4, 'QUEUED')
     RETURNING *`,
    [tenantId, instance, number, message],
  );
  return rows[0];
}

/** The oldest queued row for an instance (attempts asc, created_at asc), or null. */
export async function nextQueued({ tenantId, instance }) {
  const { rows } = await query(
    `SELECT * FROM wa_queue
      WHERE tenant_id = $1 AND instance = $2 AND status = 'QUEUED'
      ORDER BY attempts ASC, created_at ASC
      LIMIT 1`,
    [tenantId, instance],
  );
  return rows[0] || null;
}

/** Distinct (tenant_id, instance) pairs that currently have queued messages. */
export async function instancesWithQueued() {
  const { rows } = await query(
    `SELECT DISTINCT tenant_id, instance FROM wa_queue WHERE status = 'QUEUED'`,
  );
  return rows;
}

/** Mark a row sent. */
export async function markSent(id) {
  await query(`UPDATE wa_queue SET status = 'SENT', sent_at = now() WHERE id = $1`, [id]);
}

/**
 * Record a failed send attempt. Increments attempts; marks FAILED once the
 * attempt count reaches maxAttempts, otherwise leaves it QUEUED for retry.
 */
export async function recordFailure(id, maxAttempts) {
  const { rows } = await query(
    `UPDATE wa_queue
        SET attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= $2 THEN 'FAILED' ELSE 'QUEUED' END
      WHERE id = $1
      RETURNING attempts, status`,
    [id, maxAttempts],
  );
  return rows[0];
}

/** Delete rows by status; returns the deleted count. */
export async function purge({ tenantId = 'default', status = 'QUEUED' }) {
  const { rowCount } = await query(
    `DELETE FROM wa_queue WHERE tenant_id = $1 AND status = $2`,
    [tenantId, status],
  );
  return rowCount;
}

/** Count rows grouped by status for the dashboard/admin. */
export async function depth({ tenantId = 'default' }) {
  const { rows } = await query(
    `SELECT status, count(*)::int AS n FROM wa_queue WHERE tenant_id = $1 GROUP BY status`,
    [tenantId],
  );
  return rows.reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});
}

export default { enqueue, nextQueued, instancesWithQueued, markSent, recordFailure, purge, depth };
