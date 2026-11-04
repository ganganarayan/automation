/**
 * Work-page reads (Today, Calendar, Log and cost).
 *
 * Purpose:      The read-only queries behind the admin work pages, kept in one
 *               place so the pages stay cheap: DB only, no Drive / Post for Me
 *               calls on page load.
 * Responsibility: SELECTs only. router_days belongs to the daily router (it may
 *               not exist yet on an older database), so its reads return null
 *               instead of throwing and the page shows "not checked yet".
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

const READY_SOURCES = ['drive_folder', 'drive_pick'];

/** Instances waiting on a person (statuses from libraryStatus.NEEDS_YOU_STATUSES). */
export async function needsYou({ tenantId = 'default', statuses = [], limit = 50 }) {
  if (!statuses.length) return [];
  const { rows } = await query(
    `SELECT id, title, funnel_id, funnel_name, status, scheduled_for, updated_at
       FROM instances
      WHERE tenant_id = $1 AND status = ANY($2::text[])
      ORDER BY updated_at DESC LIMIT $3`,
    [tenantId, statuses, limit],
  );
  return rows;
}

/** Image-gate (and other image) approvals still pending from the last few days. */
export async function pendingImageApprovals({ tenantId = 'default', days = 3, limit = 20 }) {
  const { rows } = await query(
    `SELECT id, kind, payload, created_at
       FROM approvals
      WHERE tenant_id = $1 AND status = 'pending' AND kind LIKE '%image%'
        -- Router image posts already show as their image_review instance.
        AND kind <> 'image_post'
        AND created_at > now() - make_interval(days => $2)
      ORDER BY created_at DESC LIMIT $3`,
    [tenantId, days, limit],
  );
  return rows;
}

/** Posted / scheduled counts for one IST day ([fromUtc, toUtc) as ISO strings). */
export async function liveCounts({ tenantId = 'default', fromUtc, toUtc }) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE status IN ('posted', 'partial') AND posted_at >= $2 AND posted_at < $3)::int AS posted,
       count(*) FILTER (WHERE status = 'scheduled' AND scheduled_for >= $2 AND scheduled_for < $3)::int AS scheduled
       FROM instances WHERE tenant_id = $1`,
    [tenantId, fromUtc, toUtc],
  );
  return rows[0] || { posted: 0, scheduled: 0 };
}

/**
 * Ready videos already pulled in but not yet scheduled or posted. A DB-only
 * stand-in for "videos left": files still sitting in Drive are not counted.
 */
export async function readyLeft({ tenantId = 'default' }) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM instances
      WHERE tenant_id = $1 AND locked = false
        AND status IN ('draft', 'transcript_review', 'approved', 'ready')
        AND source_type = ANY($2::text[])`,
    [tenantId, READY_SOURCES],
  );
  return rows[0] ? rows[0].n : 0;
}

/**
 * The router's per-funnel decisions for IST dates [fromDay, toDay] (yyyy-MM-dd).
 * @returns {Promise<object[]|null>} null when router_days does not exist yet.
 */
export async function routerDays({ tenantId = 'default', fromDay, toDay }) {
  try {
    const { rows } = await query(
      `SELECT funnel_id, to_char(post_date, 'YYYY-MM-DD') AS day, lane, reason, instance_id, created_at
         FROM router_days
        WHERE tenant_id = $1 AND post_date BETWEEN $2::date AND $3::date
        ORDER BY post_date, funnel_id`,
      [tenantId, fromDay, toDay],
    );
    return rows;
  } catch {
    return null; // table missing (router not migrated yet) or not readable
  }
}

/** Instances scheduled or posted in [fromUtc, toUtc), oldest first. */
export async function calendarInstances({ tenantId = 'default', fromUtc, toUtc }) {
  const { rows } = await query(
    `SELECT id, title, funnel_id, funnel_name, status, source_type, scheduled_for, posted_at
       FROM instances
      WHERE tenant_id = $1 AND status <> 'superseded'
        AND ((scheduled_for >= $2 AND scheduled_for < $3) OR (posted_at >= $2 AND posted_at < $3))
      ORDER BY COALESCE(posted_at, scheduled_for)`,
    [tenantId, fromUtc, toUtc],
  );
  return rows;
}

/** Total real AI cost and run count since `fromUtc`, deleted runs included. */
export async function costSince({ tenantId = 'default', fromUtc }) {
  const { rows } = await query(
    `SELECT COALESCE(sum(cost_usd), 0)::float AS total, count(*)::int AS runs,
            COALESCE(sum(cost_usd) FILTER (WHERE deleted), 0)::float AS deleted
       FROM (SELECT cost_usd, false AS deleted FROM instances WHERE tenant_id = $1 AND created_at >= $2
             UNION ALL
             SELECT cost_usd, true FROM deleted_instances WHERE tenant_id = $1 AND created_at >= $2) t`,
    [tenantId, fromUtc],
  );
  return rows[0] || { total: 0, runs: 0, deleted: 0 };
}

/** The deleted-instance log, newest first. */
export async function deletedRows({ tenantId = 'default', limit = 200 }) {
  const { rows } = await query(
    `SELECT id, title, funnel_name, status, cost_usd, steps, created_at, deleted_at
       FROM deleted_instances WHERE tenant_id = $1 ORDER BY deleted_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

/** All-time cost and count of deleted instances, optionally for one funnel. */
export async function deletedTotal({ tenantId = 'default', funnelId = null }) {
  const { rows } = await query(
    `SELECT COALESCE(sum(cost_usd), 0)::float AS total, count(*)::int AS n
       FROM deleted_instances WHERE tenant_id = $1 AND ($2::bigint IS NULL OR funnel_id = $2::bigint)`,
    [tenantId, funnelId],
  );
  return rows[0] || { total: 0, n: 0 };
}

export default { needsYou, pendingImageApprovals, liveCounts, readyLeft, routerDays, calendarInstances, costSince, deletedRows, deletedTotal };
