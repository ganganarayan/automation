/**
 * admins data access.
 *
 * Purpose:      Manage admin identities and roles (super_admin / admin).
 * Responsibility: The only place admins SQL runs.
 * Dependencies: core/db.
 *
 * The super admin (ganganarayan.rns@gmail.com) is seeded by migration and is
 * protected here from role downgrade or deletion.
 */
import { query } from '../core/db.js';

export const SUPER_ADMIN_EMAIL = 'ganganarayan.rns@gmail.com';

/** List all admins (super admin first, then by tenant/email). */
export async function list() {
  const { rows } = await query(
    `SELECT email, role, tenant_id, created_at FROM admins
      ORDER BY (role = 'super_admin') DESC, tenant_id NULLS FIRST, email`,
  );
  return rows;
}

/** Fetch one admin by email, or null. */
export async function findByEmail(email) {
  const { rows } = await query('SELECT * FROM admins WHERE email = $1', [String(email).toLowerCase()]);
  return rows[0] || null;
}

/**
 * Add or update an admin. The super admin's email is always kept as
 * super_admin; other emails default to the 'admin' role, scoped to a tenant.
 * @param {object} args - { email, role, tenantId }
 */
export async function upsert({ email, role = 'admin', tenantId = null }) {
  const normalized = String(email).trim().toLowerCase();
  if (!normalized) throw new Error('email required');
  const finalRole = normalized === SUPER_ADMIN_EMAIL ? 'super_admin' : role === 'super_admin' ? 'admin' : role;
  const finalTenant = finalRole === 'super_admin' ? null : tenantId || 'default';
  const { rows } = await query(
    `INSERT INTO admins (email, role, tenant_id) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, tenant_id = EXCLUDED.tenant_id
     RETURNING email, role, tenant_id, created_at`,
    [normalized, finalRole, finalTenant],
  );
  return rows[0];
}

/** Remove an admin (never the super admin). */
export async function remove(email) {
  const normalized = String(email).trim().toLowerCase();
  if (normalized === SUPER_ADMIN_EMAIL) return false;
  await query('DELETE FROM admins WHERE email = $1', [normalized]);
  return true;
}

export default { list, findByEmail, upsert, remove, SUPER_ADMIN_EMAIL };
