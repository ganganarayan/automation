/**
 * event_log data access.
 *
 * Purpose:      Append business events for debugging/replay/audit/analytics.
 * Responsibility: The only place event_log SQL runs.
 * Dependencies: core/db, settings.
 */
import { query } from '../core/db.js';
import { settings } from '../settings/index.js';

/** Insert an event row. */
export async function append({ tenantId = 'default', eventType, payload = {} }) {
  await query(
    `INSERT INTO event_log (tenant_id, service, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, settings.service, eventType, payload],
  );
}

/** Recent events for a tenant (for the admin/events endpoint). */
export async function recent({ tenantId = 'default', limit = 100 }) {
  const { rows } = await query(
    `SELECT id, tenant_id, service, event_type, payload, created_at
       FROM event_log
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

export default { append, recent };
