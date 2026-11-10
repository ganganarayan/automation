/**
 * Plan service.
 *
 * Purpose:      Enforce a tenant's plan (utils/planSpec) and its live state
 *               (active, not expired) where the app creates or posts things.
 * Responsibility:
 *               - tenantInfo(tenantId): { plan, live, reason, expiresAt } (60 s cache)
 *               - monthUsage(tenantId): posts and AI videos this IST month
 *               - limitReason(tenantId, what, adding): '' or the reason
 * Dependencies: core/db, tenantRepository, planSpec.
 *
 * Posts this month: the tenant's instances due this IST month (scheduled_for),
 * not failed or replaced: one per post, router or manual alike. AI videos: the
 * router's ai_video days this IST month.
 */
import { query } from '../core/db.js';
import * as tenantRepo from '../repositories/tenantRepository.js';
import { limitsFor, overLimit, tenantLive } from '../utils/planSpec.js';

const TTL_MS = 60_000;
const cache = new Map();

export function invalidate(tenantId) {
  if (tenantId) cache.delete(String(tenantId));
  else cache.clear();
}

/** The tenant's plan and whether it may act. Unknown tenants are not live. */
export async function tenantInfo(tenantId) {
  const id = String(tenantId || 'default');
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
  const row = await tenantRepo.findById(id);
  const live = tenantLive(row);
  const info = { tenantId: id, plan: (row && row.plan) || 'custom', live: live.live, reason: live.reason, expiresAt: row ? row.expires_at : null };
  cache.set(id, { at: Date.now(), info });
  return info;
}

// The IST month as a UTC range: [start, next).
const MONTH_SQL = `date_trunc('month', (now() AT TIME ZONE 'UTC') + interval '330 minutes')`;

export async function monthUsage(tenantId) {
  const id = String(tenantId || 'default');
  const posts = await query(
    `SELECT count(*)::int AS n FROM instances
      WHERE tenant_id = $1 AND status NOT IN ('failed', 'superseded') AND title <> 'SAMPLE: delete me'
        AND scheduled_for >= ((${MONTH_SQL} - interval '330 minutes') AT TIME ZONE 'UTC')
        AND scheduled_for <  ((${MONTH_SQL} + interval '1 month' - interval '330 minutes') AT TIME ZONE 'UTC')`,
    [id],
  );
  const ai = await query(
    `SELECT count(*)::int AS n FROM router_days
      WHERE tenant_id = $1 AND lane = 'ai_video'
        AND post_date >= (${MONTH_SQL})::date AND post_date < (${MONTH_SQL} + interval '1 month')::date`,
    [id],
  );
  return { posts: posts.rows[0].n, aiVideos: ai.rows[0].n };
}

/**
 * '' when the tenant may add `adding` more of `what` (posts | aiVideos |
 * funnels | channels | users), else the reason. `used` is counted here for
 * posts and AI videos; pass it for the others.
 */
export async function limitReason(tenantId, what, { adding = 1, used = null } = {}) {
  const info = await tenantInfo(tenantId);
  if (!info.live) return `This workspace cannot ${what === 'posts' ? 'post' : 'add more'} right now: ${info.reason}. Ask the owner to renew.`;
  const lim = limitsFor(info.plan);
  if (lim[what] === null || lim[what] === undefined) return '';
  let n = used;
  if (n === null) n = what === 'posts' || what === 'aiVideos' ? (await monthUsage(tenantId))[what] : 0;
  return overLimit(info.plan, what, n, adding);
}

export default { tenantInfo, monthUsage, limitReason, invalidate };
