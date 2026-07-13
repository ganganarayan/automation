/**
 * tenant_config data access.
 *
 * Purpose:      Read/write per-tenant configuration overrides.
 * Responsibility: The only place tenant_config SQL runs.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/** Fetch all config rows for a tenant as a { key: value } map. */
export async function getAll(tenantId) {
  const { rows } = await query(
    'SELECT key, value FROM tenant_config WHERE tenant_id = $1',
    [tenantId],
  );
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Fetch a single config value, or null. */
export async function get(tenantId, key) {
  const { rows } = await query(
    'SELECT value FROM tenant_config WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  return rows[0]?.value ?? null;
}

/** Upsert a config value. */
export async function set(tenantId, key, value) {
  await query(
    `INSERT INTO tenant_config (tenant_id, key, value, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [tenantId, key, value],
  );
}

/** Delete a config override (reverts the key to its env default). */
export async function del(tenantId, key) {
  await query('DELETE FROM tenant_config WHERE tenant_id = $1 AND key = $2', [tenantId, key]);
}

export default { getAll, get, set, del };
