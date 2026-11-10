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

export default { tenantOf, validId };
