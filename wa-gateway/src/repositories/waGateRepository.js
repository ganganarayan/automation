/**
 * wa_gate data access (per-instance throttle gate).
 *
 * Purpose:      Enforce the randomized inter-message gap per instance so that
 *               even with concurrent dispatcher ticks, at most one message per
 *               instance is released per gap window.
 * Responsibility: The only place wa_gate SQL runs. The claim is a single atomic
 *               UPDATE ... RETURNING; if it returns a row, the caller "won" the
 *               gate and may send exactly one message.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/**
 * Atomically try to open the gate for an instance.
 *  - ensures a row exists
 *  - updates next_send_at to (now + gapMs) ONLY IF the current next_send_at is
 *    already in the past, returning the row on success
 *
 * @returns {Promise<boolean>} true if this caller may send now.
 */
export async function tryClaim({ tenantId = 'default', instance, nowMs, gapMs }) {
  // Ensure the gate row exists (idempotent).
  await query(
    `INSERT INTO wa_gate (tenant_id, k, next_send_at)
     VALUES ($1, $2, 0)
     ON CONFLICT (tenant_id, k) DO NOTHING`,
    [tenantId, instance],
  );

  const { rows } = await query(
    `UPDATE wa_gate
        SET next_send_at = $3 + $4
      WHERE tenant_id = $1 AND k = $2 AND next_send_at <= $3
      RETURNING k`,
    [tenantId, instance, nowMs, gapMs],
  );
  return rows.length > 0;
}

/**
 * Roll the gate back so the next tick can retry immediately. Used when a claim
 * was won but the actual send could not proceed (e.g. connection not open), so
 * the reserved gap is not "wasted".
 */
export async function release({ tenantId = 'default', instance, nowMs }) {
  await query(
    `UPDATE wa_gate SET next_send_at = $3 WHERE tenant_id = $1 AND k = $2`,
    [tenantId, instance, nowMs],
  );
}

export default { tryClaim, release };
