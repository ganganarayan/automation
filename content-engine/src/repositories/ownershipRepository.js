/**
 * Record ownership lookups.
 *
 * Purpose:      Which tenant a record belongs to, so a request can be refused
 *               before it reads or changes another tenant's record.
 * Responsibility: The tenant_id of one funnel, instance, capture rule or lead.
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

const TABLES = {
  funnel: { table: 'funnels', id: 'bigint' },
  instance: { table: 'instances', id: 'uuid' },
  rule: { table: 'keyword_rules', id: 'bigint' },
  lead: { table: 'captured_leads', id: 'bigint' },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id is well formed for its table (a bad one is simply not found). */
export function validId(kind, id) {
  const t = TABLES[kind];
  if (!t) return false;
  const s = String(id ?? '').trim();
  return t.id === 'uuid' ? UUID.test(s) : /^\d{1,18}$/.test(s);
}

/** The owning tenant id, or null when there is no such record. */
export async function tenantOf(kind, id) {
  if (!validId(kind, id)) return null;
  const t = TABLES[kind];
  const { rows } = await query(`SELECT tenant_id FROM ${t.table} WHERE id = $1`, [String(id).trim()]);
  return rows[0] ? String(rows[0].tenant_id) : null;
}

/**
 * The tenants whose funnels use this Drive folder (as a media or ready-video
 * folder, or a saved source). A folder setting may hold a link, so it matches
 * on the id inside it.
 */
export async function driveFolderTenants(folderId) {
  const id = String(folderId || '').trim();
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return [];
  const { rows } = await query(
    `SELECT DISTINCT f.tenant_id FROM funnel_config c JOIN funnels f ON f.id = c.funnel_id
      WHERE c.key IN ('drive_folder_id', 'direct_drive_folder') AND position($1 in c.value) > 0
     UNION
     SELECT DISTINCT tenant_id FROM funnel_sources WHERE position($1 in ref) > 0`,
    [id],
  );
  return rows.map((r) => String(r.tenant_id));
}

export default { tenantOf, validId, driveFolderTenants };
