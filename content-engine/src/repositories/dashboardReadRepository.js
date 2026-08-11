/**
 * Dashboard cross-service read layer.
 *
 * Purpose:      Provide the unified operations dashboard with a read-only view
 *               across all three services' tables. Because the platform shares
 *               one Postgres, content-engine can read wa-gateway's and
 *               tracking-bridge's tables directly for display.
 * Responsibility: Read-only SQL only. Every query is guarded so a missing table
 *               or an unreachable database degrades a panel to "unavailable"
 *               instead of failing the whole page.
 * Dependencies: core/db.
 *
 * This is deliberately separate from the per-table repositories: it is an
 * operational read view, not part of any service's write path.
 */
import { query } from '../core/db.js';

/** Run a read query, returning `fallback` (default null) on any error. */
async function safe(fn, fallback = null) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

// ---- tracking-bridge --------------------------------------------------------

/** Recent CAPI purchase events (from the shared event_log). */
export function recentPurchases(tenantId = 'default', limit = 15) {
  return safe(async () => {
    const { rows } = await query(
      `SELECT payload, created_at FROM event_log
        WHERE tenant_id = $1 AND service = 'tracking-bridge' AND event_type = 'capi.purchase'
        ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return rows;
  });
}

/** Count of CAPI purchases recorded today (UTC-based count is fine for a tile). */
export function purchasesToday(tenantId = 'default') {
  return safe(async () => {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM event_log
        WHERE tenant_id = $1 AND service = 'tracking-bridge' AND event_type = 'capi.purchase'
          AND created_at >= date_trunc('day', now())`,
      [tenantId],
    );
    return rows[0]?.n ?? 0;
  }, 0);
}

// ---- generic (any service) --------------------------------------------------

/** Recent events for a given service from the shared event_log. */
export function recentEvents(service, tenantId = 'default', limit = 15) {
  return safe(async () => {
    const { rows } = await query(
      `SELECT event_type, payload, created_at FROM event_log
        WHERE tenant_id = $1 AND service = $2
        ORDER BY created_at DESC LIMIT $3`,
      [tenantId, service, limit],
    );
    return rows;
  });
}

export default {
  recentPurchases,
  purchasesToday,
  recentEvents,
};
