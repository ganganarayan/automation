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

/** Every active tenant's id (background jobs loop over these). */
export async function activeIds() {
  // Live only: active and not past its expiry (an expired tenant's jobs stop).
  const { rows } = await query(
    "SELECT id FROM tenants WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now()) ORDER BY (id = $1) DESC, created_at ASC",
    ['default'],
  );
  return rows.map((r) => String(r.id));
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

/** Every tenant with its subscription details (the super admin's Tenants list). */
export async function listWithSubscription() {
  const { rows } = await query(
    `SELECT id, name, status, plan, owner_email, phone, COALESCE(subscribed_at, created_at) AS subscribed_at, expires_at
       FROM tenants ORDER BY (id = $1) DESC, created_at ASC`,
    ['default'],
  );
  return rows;
}

/** Set (or clear, with null) a tenant's expiry date. */
export async function setExpiry(tenantId, expiresAt) {
  const { rowCount } = await query('UPDATE tenants SET expires_at = $2 WHERE id = $1', [tenantId, expiresAt]);
  if (!rowCount) throw new Error('tenant not found');
}

/** A new tenant with its details (super admin). Fails if the id is taken. */
export async function createNew({ id, name, ownerEmail, phone = '', plan = 'custom', expiresAt = null }) {
  const { rows } = await query(
    `INSERT INTO tenants (id, name, status, owner_email, phone, plan, subscribed_at, expires_at)
     VALUES ($1, $2, 'active', $3, $4, $5, now(), $6)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, name, status, plan, owner_email, phone, subscribed_at, expires_at`,
    [id, name || id, String(ownerEmail || '').trim().toLowerCase(), phone || null, plan, expiresAt],
  );
  if (!rows[0]) throw new Error('that workspace id is taken');
  return rows[0];
}

/** Change a tenant's plan. */
export async function setPlan(tenantId, plan) {
  const { rowCount } = await query('UPDATE tenants SET plan = $2 WHERE id = $1', [tenantId, plan]);
  if (!rowCount) throw new Error('tenant not found');
}

export default { createNew, setPlan, isActive, activeIds, findById, list, create, listWithSubscription, setExpiry };
