/**
 * tenants data access.
 *
 * Purpose:      Look up tenants (used to validate an incoming tenant id).
 * Responsibility: The only place tenants SQL runs.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/** Return true if a tenant id exists and is active. */
export async function isActive(tenantId) {
  const { rows } = await query(
    "SELECT 1 FROM tenants WHERE id = $1 AND status = 'active'",
    [tenantId],
  );
  return rows.length > 0;
}

/** Fetch a tenant row or null. */
export async function findById(tenantId) {
  const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  return rows[0] || null;
}

export default { isActive, findById };
