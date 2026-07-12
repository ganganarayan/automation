/**
 * relay_control data access (per-account Delay Relay config).
 *
 * Purpose:      Store the ramp configuration, destination URL, and log sheet id
 *               for each Delay Relay account.
 * Responsibility: The only place relay_control SQL runs.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/** Fetch the control row for an account, or null. */
export async function get({ tenantId = 'default', account }) {
  const { rows } = await query(
    `SELECT * FROM relay_control WHERE tenant_id = $1 AND account = $2`,
    [tenantId, account],
  );
  return rows[0] || null;
}

/** Ensure a control row exists with defaults; returns it. */
export async function ensure({ tenantId = 'default', account }) {
  await query(
    `INSERT INTO relay_control (tenant_id, account) VALUES ($1, $2)
     ON CONFLICT (tenant_id, account) DO NOTHING`,
    [tenantId, account],
  );
  return get({ tenantId, account });
}

/** All configured accounts (for the sender cron). */
export async function all() {
  const { rows } = await query(`SELECT * FROM relay_control`);
  return rows;
}

/** Persist the ramp progress after a run. */
export async function saveProgress({ tenantId = 'default', account, rampDay, lastQty }) {
  await query(
    `UPDATE relay_control SET ramp_day = $3, last_qty = $4, updated_at = now()
      WHERE tenant_id = $1 AND account = $2`,
    [tenantId, account, rampDay, lastQty],
  );
}

export default { get, ensure, all, saveProgress };
