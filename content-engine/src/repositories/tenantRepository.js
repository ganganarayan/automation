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

/** List all tenants (for the config UI selector). */
export async function list() {
  const { rows } = await query(
    'SELECT id, name, status, created_at FROM tenants ORDER BY (id = $1) DESC, created_at ASC',
    ['default'],
  );
  return rows;
}

/**
 * Create a tenant if it doesn't exist. Returns the row.
 * @param {object} args - { id, name }
 */
export async function create({ id, name }) {
  const { rows } = await query(
    `INSERT INTO tenants (id, name, status) VALUES ($1, $2, 'active')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name, status, created_at`,
    [id, name || id],
  );
  return rows[0];
}

export default { isActive, findById, list, create };
