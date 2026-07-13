/**
 * Daily Meta ad-insights pull.
 *
 * Purpose:      Pull ad-level insights for the lookback window, flatten them, and
 *               upsert into a Google Sheet keyed on row_key so re-runs are
 *               idempotent (and raising the lookback backfills).
 * Responsibility: fetch -> flatten -> upsert.
 * Dependencies: providers (meta, sheets), insightsFlatten, settings, time utils.
 */
import { flattenInsightRow, INSIGHT_COLUMNS } from './insightsFlatten.js';
import * as tenantSettings from '../core/tenantSettings.js';
import { createMetaProvider } from '../providers/metaProvider.js';
import { nowIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

const FIELDS = [
  'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
  'spend', 'impressions', 'reach', 'frequency', 'clicks', 'ctr', 'cpc', 'cpm',
  'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions',
  'video_p95_watched_actions', 'video_p100_watched_actions',
  'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking',
  'actions', 'action_values', 'purchase_roas', 'date_start', 'date_stop',
];

const TAB = 'Sheet1';

/** Run the pull for the configured lookback window. */
export async function run({ tenantId = 'default', providers }) {
  const log = childLogger({ module: 'adInsights', tenant_id: tenantId });
  const resolved = await tenantSettings.forTenant(tenantId);
  if (!resolved.meta.adAccountId || !resolved.insights.sheetId) {
    log.warn('ad account id or insights sheet id not configured; skipping');
    return { rows: 0 };
  }

  const meta = createMetaProvider(resolved.meta, log);
  const lookback = Math.max(1, resolved.insights.lookbackDays);
  const until = nowIst().minus({ days: 1 }).toFormat('yyyy-MM-dd'); // yesterday
  const since = nowIst().minus({ days: lookback }).toFormat('yyyy-MM-dd');

  const raw = await meta.fetchInsights({
    adAccountId: resolved.meta.adAccountId,
    fields: FIELDS,
    since,
    until,
  });

  const pulledAt = nowIst().toISO();
  const flat = raw.map((r) => flattenInsightRow(r, pulledAt));

  // Ensure header, then idempotent upsert keyed on row_key.
  const existing = await providers.sheets.readTab(resolved.insights.sheetId, TAB, { fresh: true });
  if (!existing.length) {
    await providers.sheets.appendRow(resolved.insights.sheetId, TAB, INSIGHT_COLUMNS);
  }
  const asObjects = flat.map((f) => {
    const obj = {};
    for (const col of INSIGHT_COLUMNS) obj[col] = f[col];
    return obj;
  });
  await providers.sheets.upsertByKey(resolved.insights.sheetId, TAB, 'row_key', asObjects);

  log.info({ rows: flat.length, since, until }, 'ad insights upserted');
  return { rows: flat.length, since, until };
}

export default { run };
