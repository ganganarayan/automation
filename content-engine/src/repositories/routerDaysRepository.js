/**
 * router_days data access.
 *
 * Purpose:      Record the daily router's decision per funnel per IST post date
 *               (which lane delivers that day's post, why, and the instance).
 * Responsibility: The only place router_days SQL runs. The (funnel_id,
 *               post_date) unique key is the router's idempotency guard: claim()
 *               wins once, so a double ping never lines up two posts.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/** The decision for a funnel on an IST date (yyyy-MM-dd), or null. */
export async function get(funnelId, postDate) {
  const { rows } = await query('SELECT * FROM router_days WHERE funnel_id = $1 AND post_date = $2::date', [funnelId, postDate]);
  return rows[0] || null;
}

/**
 * Claim the day for a funnel. Returns the new row, or null when another run
 * (or the legacy poster) already claimed it.
 */
export async function claim({ tenantId = 'default', funnelId, postDate, lane, reason = '', instanceId = null }) {
  const { rows } = await query(
    `INSERT INTO router_days (tenant_id, funnel_id, post_date, lane, reason, instance_id)
     VALUES ($1, $2, $3::date, $4, $5, $6)
     ON CONFLICT (funnel_id, post_date) DO NOTHING
     RETURNING *`,
    [tenantId, funnelId, postDate, lane, reason, instanceId],
  );
  return rows[0] || null;
}

/** Update a claimed day (the lane's outcome: its instance, or 'none' + the error). */
export async function update(id, { lane, reason, instanceId } = {}) {
  await query(
    `UPDATE router_days
        SET lane = COALESCE($2, lane), reason = COALESCE($3, reason), instance_id = COALESCE($4, instance_id)
      WHERE id = $1`,
    [id, lane ?? null, reason ?? null, instanceId ?? null],
  );
}

/** Drop a 'none' day so a manual re-run can decide it again. */
export async function releaseNone(funnelId, postDate) {
  const { rowCount } = await query(
    `DELETE FROM router_days WHERE funnel_id = $1 AND post_date = $2::date AND lane = 'none'`,
    [funnelId, postDate],
  );
  return rowCount > 0;
}

/** Drop a funnel's day whatever its lane (the super-admin re-run). Returns the removed row or null. */
export async function release(funnelId, postDate) {
  const { rows } = await query(
    'DELETE FROM router_days WHERE funnel_id = $1 AND post_date = $2::date RETURNING *',
    [funnelId, postDate],
  );
  return rows[0] || null;
}

/** A tenant's decisions for a date range (inclusive, IST dates), by funnel. */
export async function listByDates(tenantId = 'default', fromDate, toDate) {
  const { rows } = await query(
    `SELECT * FROM router_days WHERE tenant_id = $1 AND post_date BETWEEN $2::date AND $3::date
      ORDER BY post_date, funnel_id`,
    [tenantId, fromDate, toDate],
  );
  return rows;
}

export default { get, claim, update, releaseNone, release, listByDates };
