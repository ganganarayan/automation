/**
 * Plan service.
 *
 * Purpose:      Enforce a tenant's plan (utils/planSpec) and its live state
 *               (active, not expired) where the app creates or posts things.
 * Responsibility:
 *               - tenantInfo(tenantId): { plan, live, reason, expiresAt } (60 s cache)
 *               - monthUsage(tenantId): posts and AI videos this IST month
 *               - limitReason(tenantId, what, adding): '' or the reason
 *               - clientReason(parentId): '' or why the agency cannot add a client
 * Dependencies: core/db, tenantRepository, planSpec.
 *
 * Posts this month: the tenant's instances due this IST month (scheduled_for),
 * not failed or replaced: one per post, router or manual alike. AI videos: the
 * router's ai_video days this IST month.
 */
import { query } from '../core/db.js';
import * as tenantRepo from '../repositories/tenantRepository.js';
import { limitsForTenant, overLimit, tenantLive } from '../utils/planSpec.js';
import { AGENCY_PLAN, combineLive, clientProblem } from '../utils/workspaceSpec.js';

const TTL_MS = 60_000;
const cache = new Map();

// A change to one workspace (an agency's expiry, plan or clients) changes its
// clients too, so any change clears the whole cache (there are few tenants).
export function invalidate(_tenantId) {
  cache.clear();
}

/**
 * The tenant's plan and whether it may act. Unknown tenants are not live.
 * A client of an agency uses its agency's plan and is live only while the
 * agency is. pool: the workspaces whose posts count against the same plan.
 */
export async function tenantInfo(tenantId) {
  const id = String(tenantId || 'default');
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
  const row = await tenantRepo.findById(id);
  const parent = row && row.parent_id ? await tenantRepo.findById(row.parent_id) : null;
  const live = combineLive(tenantLive(row), row && row.parent_id ? tenantLive(parent) : null);
  const head = parent || row;
  const kids = head && String(head.plan || '') === AGENCY_PLAN ? await tenantRepo.childrenOf(head.id).catch(() => []) : [];
  const info = {
    tenantId: id,
    plan: (head && head.plan) || 'custom',
    // Funnels or clients bought and extra users (the agency's, for a client).
    units: head && head.units !== undefined && head.units !== null ? Number(head.units) : null,
    extraUsers: head ? Number(head.extra_users) || 0 : 0,
    agencyId: parent ? String(parent.id) : null,
    pool: head ? [String(head.id), ...kids.map((k) => String(k.id)).filter((k) => k !== String(head.id))] : [id],
    live: live.live,
    reason: live.reason,
    expiresAt: live.by === 'agency' ? parent.expires_at : (row ? row.expires_at : null),
  };
  cache.set(id, { at: Date.now(), info });
  return info;
}

// The IST month as a UTC range: [start, next).
const MONTH_SQL = `date_trunc('month', (now() AT TIME ZONE 'UTC') + interval '330 minutes')`;

/** Posts and AI videos this IST month, across the tenant's plan pool (an agency and its clients). */
export async function monthUsage(tenantId) {
  const id = String(tenantId || 'default');
  const info = await tenantInfo(id).catch(() => null);
  const ids = info && Array.isArray(info.pool) && info.pool.length ? info.pool : [id];
  const posts = await query(
    `SELECT count(*)::int AS n FROM instances
      WHERE tenant_id = ANY($1::text[]) AND status NOT IN ('failed', 'superseded') AND title <> 'SAMPLE: delete me'
        AND scheduled_for >= ((${MONTH_SQL} - interval '330 minutes') AT TIME ZONE 'UTC')
        AND scheduled_for <  ((${MONTH_SQL} + interval '1 month' - interval '330 minutes') AT TIME ZONE 'UTC')`,
    [ids],
  );
  const ai = await query(
    `SELECT count(*)::int AS n FROM router_days
      WHERE tenant_id = ANY($1::text[]) AND lane = 'ai_video'
        AND post_date >= (${MONTH_SQL})::date AND post_date < (${MONTH_SQL} + interval '1 month')::date`,
    [ids],
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
  const lim = limitsForTenant(info.plan, { units: info.units, extraUsers: info.extraUsers });
  if (lim[what] === null || lim[what] === undefined) return '';
  let n = used;
  if (n === null) n = what === 'posts' || what === 'aiVideos' ? (await monthUsage(tenantId))[what] : 0;
  return overLimit(info.plan, what, n, adding, lim);
}

/** '' when `parentId` may take one more client, else the reason (the plan's clients limit). */
export async function clientReason(parentId) {
  const parent = parentId ? await tenantRepo.findById(String(parentId)) : null;
  const clients = parent ? await tenantRepo.countChildren(parent.id) : 0;
  const lim = parent ? limitsForTenant(parent.plan, { units: parent.units, extraUsers: parent.extra_users }) : null;
  return clientProblem({ parent, clients, limit: lim ? lim.clients : null });
}

export default { tenantInfo, monthUsage, limitReason, clientReason, invalidate };
