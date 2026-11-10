/**
 * Provider usage per tenant.
 *
 * Purpose:      What each tenant's AI work cost, per provider per IST month, so
 *               the owner can bill. Runs keep their costs on their steps (also
 *               after a delete or a Remake, in deleted_instances); calls outside
 *               a run go to usage_ledger.
 * Responsibility: record(entry); monthCosts({ months }).
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

const SAMPLE = 'SAMPLE: delete me';

/** Keep one paid call that belongs to no run. Never throws (spend is logged, work goes on). */
export async function record({ tenantId = 'default', provider, model = null, unit = null, quantity = 0, costUsd = 0, source = '', keyOwner = 'platform' }) {
  try {
    await query(
      `INSERT INTO usage_ledger (tenant_id, provider, model, unit, quantity, cost_usd, source, key_owner)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, String(provider || 'unknown'), model, unit, Number(quantity) || 0, Number(costUsd) || 0, String(source || '').slice(0, 80), keyOwner === 'tenant' ? 'tenant' : 'platform'],
    );
    return true;
  } catch {
    return false;
  }
}

// One cost entry of a run's steps: its own time when it has one, else the run's.
const stepCosts = (t) => `
  SELECT ${t}.tenant_id,
         CASE WHEN e->>'at' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (e->>'at')::timestamptz ELSE ${t}.created_at END AS at,
         COALESCE(NULLIF(e->>'provider', ''), 'unknown') AS provider,
         CASE WHEN jsonb_typeof(e->'costUsd') = 'number' THEN (e->>'costUsd')::numeric ELSE 0 END AS usd,
         NULLIF(e->>'keyOwner', '') AS key_owner
    FROM ${t === 'i' ? 'instances' : 'deleted_instances'} ${t},
         jsonb_array_elements(CASE WHEN jsonb_typeof(${t}.steps) = 'array' THEN ${t}.steps ELSE '[]'::jsonb END) s,
         jsonb_array_elements(CASE WHEN jsonb_typeof(s->'costs') = 'array' THEN s->'costs' ELSE '[]'::jsonb END) e
   WHERE ${t}.title <> '${SAMPLE}'`;

/**
 * Cost per tenant, IST day, provider and key owner (when the entry kept one):
 * [{ tenant_id, day: 'YYYY-MM-DD', month: 'YYYY-MM', provider, key_owner, usd }].
 */
export async function monthCosts({ months = 3 } = {}) {
  const n = Math.max(1, Math.min(24, Number(months) || 3));
  const { rows } = await query(
    `WITH c AS (
       ${stepCosts('i')}
       UNION ALL
       ${stepCosts('d')}
       UNION ALL
       SELECT tenant_id, at, provider, cost_usd AS usd, key_owner FROM usage_ledger
     )
     SELECT tenant_id, to_char((at AT TIME ZONE 'UTC') + interval '330 minutes', 'YYYY-MM-DD') AS day,
            to_char((at AT TIME ZONE 'UTC') + interval '330 minutes', 'YYYY-MM') AS month, provider, key_owner, sum(usd)::float AS usd
       FROM c
      WHERE at >= ((date_trunc('month', (now() AT TIME ZONE 'UTC') + interval '330 minutes') - make_interval(months => $1::int - 1) - interval '330 minutes') AT TIME ZONE 'UTC')
      GROUP BY 1, 2, 3, 4, 5
     HAVING sum(usd) > 0
      ORDER BY 2 DESC, 1, 6 DESC`,
    [n],
  );
  return rows;
}

export default { record, monthCosts };
