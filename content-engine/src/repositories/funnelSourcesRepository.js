/**
 * funnel_sources data access.
 *
 * Purpose:      A funnel's content sources — several per funnel (Drive folders
 *               of ready videos, sheets, the generated lane). Each instance
 *               records the one source it came from.
 * Responsibility: The only place funnel_sources SQL runs.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

export async function listByFunnel(funnelId) {
  if (!funnelId) return [];
  const { rows } = await query('SELECT * FROM funnel_sources WHERE funnel_id = $1 ORDER BY created_at', [funnelId]);
  return rows;
}

/** Save a source on the funnel (once per type + ref); returns the row. */
export async function upsert({ tenantId = 'default', funnelId, type, ref = '', label = '' }) {
  const { rows } = await query(
    `INSERT INTO funnel_sources (tenant_id, funnel_id, type, ref, label) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (funnel_id, type, ref) DO UPDATE SET label = COALESCE(NULLIF(EXCLUDED.label, ''), funnel_sources.label)
     RETURNING *`,
    [tenantId, funnelId, type, ref, label],
  );
  return rows[0];
}

export async function find(funnelId, type, ref = '') {
  const { rows } = await query('SELECT * FROM funnel_sources WHERE funnel_id = $1 AND type = $2 AND ref = $3', [funnelId, type, ref]);
  return rows[0] || null;
}

export async function remove(funnelId, id) {
  const { rowCount } = await query('DELETE FROM funnel_sources WHERE funnel_id = $1 AND id = $2', [funnelId, id]);
  return rowCount > 0;
}

export default { listByFunnel, upsert, find, remove };
