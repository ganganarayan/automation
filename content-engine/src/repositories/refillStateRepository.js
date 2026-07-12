/**
 * refill_state data access.
 *
 * Purpose:      Track whether a refill xlsx has already been sent for a brand so
 *               the watchdog doesn't email the same batch repeatedly.
 * Responsibility: The only place refill_state SQL runs.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/** Get the current flag (false if no row yet). */
export async function get({ tenantId = 'default', brand }) {
  const { rows } = await query(
    `SELECT refill_sent FROM refill_state WHERE tenant_id = $1 AND brand = $2`,
    [tenantId, brand],
  );
  return rows[0]?.refill_sent ?? false;
}

/** Set the flag. */
export async function set({ tenantId = 'default', brand, value }) {
  await query(
    `INSERT INTO refill_state (tenant_id, brand, refill_sent, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, brand) DO UPDATE SET refill_sent = EXCLUDED.refill_sent, updated_at = now()`,
    [tenantId, brand, value],
  );
}

export default { get, set };
