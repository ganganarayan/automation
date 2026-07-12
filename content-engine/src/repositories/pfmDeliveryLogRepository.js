/**
 * pfm_delivery_log data access.
 *
 * Purpose:      Record Post-for-Me delivery results and read them for the daily
 *               reports and the dashboard.
 * Responsibility: The only place pfm_delivery_log SQL runs.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/** Insert a delivery result row. */
export async function insert(row) {
  const { rows } = await query(
    `INSERT INTO pfm_delivery_log
       (tenant_id, brand, account_id, post_id, platform, account_name, success, error, day_ist)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      row.tenantId || 'default', row.brand, row.accountId, row.postId, row.platform,
      row.accountName, !!row.success, row.error ? String(row.error).slice(0, 800) : null, row.dayIst,
    ],
  );
  return rows[0];
}

/** Today's rows for a brand. */
export async function forDay({ tenantId = 'default', brand, dayIst }) {
  const { rows } = await query(
    `SELECT * FROM pfm_delivery_log WHERE tenant_id = $1 AND brand = $2 AND day_ist = $3 ORDER BY created_at ASC`,
    [tenantId, brand, dayIst],
  );
  return rows;
}

/** The latest N rows for a brand (for the VidaPulse staleness report). */
export async function latest({ tenantId = 'default', brand, limit = 50 }) {
  const { rows } = await query(
    `SELECT * FROM pfm_delivery_log WHERE tenant_id = $1 AND brand = $2 ORDER BY created_at DESC LIMIT $3`,
    [tenantId, brand, limit],
  );
  return rows;
}

/** Counts by brand+success for a given day (dashboard). */
export async function summaryForDay({ tenantId = 'default', dayIst }) {
  const { rows } = await query(
    `SELECT brand, success, count(*)::int AS n
       FROM pfm_delivery_log WHERE tenant_id = $1 AND day_ist = $2
      GROUP BY brand, success`,
    [tenantId, dayIst],
  );
  return rows;
}

export default { insert, forDay, latest, summaryForDay };
