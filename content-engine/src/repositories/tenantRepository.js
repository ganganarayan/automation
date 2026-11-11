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
  // A client is live only while its agency is.
  const { rows } = await query(
    `SELECT t.id FROM tenants t LEFT JOIN tenants p ON p.id = t.parent_id
      WHERE t.status = 'active' AND (t.expires_at IS NULL OR t.expires_at > now())
        AND (t.parent_id IS NULL OR (p.status = 'active' AND (p.expires_at IS NULL OR p.expires_at > now())))
      ORDER BY (t.id = $1) DESC, t.created_at ASC`,
    ['default'],
  );
  return rows.map((r) => String(r.id));
}

/** Fetch a tenant row or null. */
export async function findById(tenantId) {
  const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  return rows[0] || null;
}

/** An agency's clients (tenants whose parent it is), oldest first. */
export async function childrenOf(tenantId) {
  const { rows } = await query('SELECT * FROM tenants WHERE parent_id = $1 ORDER BY created_at ASC', [tenantId]);
  return rows;
}

/** How many clients an agency has (archived ones not counted). */
export async function countChildren(tenantId) {
  const { rows } = await query("SELECT count(*)::int AS n FROM tenants WHERE parent_id = $1 AND status <> 'archived'", [tenantId]);
  return rows[0].n;
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
    `SELECT id, name, status, plan, parent_id, owner_email, phone, COALESCE(subscribed_at, created_at) AS subscribed_at, expires_at, cancelled_at
       FROM tenants ORDER BY (id = $1) DESC, COALESCE(parent_id, id) ASC, (parent_id IS NOT NULL) ASC, created_at ASC`,
    ['default'],
  );
  return rows;
}

/** Mark a tenant cancelled (a Date) or renewing again (null). */
export async function setCancelled(tenantId, at) {
  const { rowCount } = await query('UPDATE tenants SET cancelled_at = $2 WHERE id = $1', [tenantId, at]);
  return rowCount > 0;
}

/** Set (or clear, with null) a tenant's expiry date. */
export async function setExpiry(tenantId, expiresAt) {
  const { rowCount } = await query('UPDATE tenants SET expires_at = $2 WHERE id = $1', [tenantId, expiresAt]);
  if (!rowCount) throw new Error('tenant not found');
}

/** A new tenant with its details (super admin). Fails if the id is taken. */
export async function createNew({ id, name, ownerEmail, phone = '', plan = 'custom', expiresAt = null, parentId = null }) {
  const { rows } = await query(
    `INSERT INTO tenants (id, name, status, owner_email, phone, plan, subscribed_at, expires_at, parent_id)
     VALUES ($1, $2, 'active', $3, $4, $5, now(), $6, $7)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, name, status, plan, parent_id, owner_email, phone, subscribed_at, expires_at`,
    [id, name || id, String(ownerEmail || '').trim().toLowerCase(), phone || null, plan, expiresAt, parentId || null],
  );
  if (!rows[0]) throw new Error('that workspace id is taken');
  return rows[0];
}

/** Set a tenant's status: active | suspended | archived. */
export async function setStatus(tenantId, status) {
  const { rowCount } = await query('UPDATE tenants SET status = $2 WHERE id = $1', [tenantId, status]);
  if (!rowCount) throw new Error('tenant not found');
}

/** Change a tenant's plan. */
export async function setPlan(tenantId, plan) {
  const { rowCount } = await query('UPDATE tenants SET plan = $2 WHERE id = $1', [tenantId, plan]);
  if (!rowCount) throw new Error('tenant not found');
}

export default { setCancelled, createNew, setPlan, setStatus, isActive, activeIds, findById, childrenOf, countChildren, list, create, listWithSubscription, setExpiry };
