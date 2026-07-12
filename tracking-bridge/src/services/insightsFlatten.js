/**
 * Meta ad-insights row flattener.
 *
 * Purpose:      Turn a raw Meta insights row into a flat, sheet-friendly record
 *               with derived conversion metrics and a stable idempotency key.
 * Responsibility: Pure logic; no I/O.
 * Dependencies: none.
 */

/** Sum action values for a set of action_types from an actions array. */
function sumActions(actions, types) {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions) {
    if (types.includes(a.action_type)) total += Number(a.value) || 0;
  }
  return total;
}

const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v) || 0);
const safeDiv = (a, b) => (b ? a / b : 0);

/**
 * Flatten one insights row.
 * @param {object} row - a raw Meta insights entry
 * @param {string} pulledAt - ISO timestamp
 * @returns {object} flat record including row_key = "{date_start}|{ad_id}"
 */
export function flattenInsightRow(row, pulledAt = new Date().toISOString()) {
  const actions = row.actions || [];
  const actionValues = row.action_values || [];

  const leads = sumActions(actions, ['lead']);
  const completeRegistration = sumActions(actions, ['complete_registration']);
  const startTrial = sumActions(actions, ['start_trial']);
  const purchases = sumActions(actions, ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase']);
  const purchaseValue = sumActions(actionValues, ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase']);
  const landingPageViews = sumActions(actions, ['landing_page_view']);
  const viewContent = sumActions(actions, ['view_content', 'offsite_conversion.fb_pixel_view_content']);
  const addToCart = sumActions(actions, ['add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart']);
  const initiateCheckout = sumActions(actions, ['initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout']);

  const spend = num(row.spend);
  const roas = safeDiv(purchaseValue, spend);

  return {
    row_key: `${row.date_start || ''}|${row.ad_id || ''}`,
    date_start: row.date_start || '',
    date_stop: row.date_stop || '',
    campaign_id: row.campaign_id || '',
    campaign_name: row.campaign_name || '',
    adset_id: row.adset_id || '',
    adset_name: row.adset_name || '',
    ad_id: row.ad_id || '',
    ad_name: row.ad_name || '',
    spend,
    impressions: num(row.impressions),
    reach: num(row.reach),
    frequency: num(row.frequency),
    clicks: num(row.clicks),
    ctr: num(row.ctr),
    cpc: num(row.cpc),
    cpm: num(row.cpm),
    video_p25: num(pickVideo(row, 'video_p25_watched_actions')),
    video_p50: num(pickVideo(row, 'video_p50_watched_actions')),
    video_p75: num(pickVideo(row, 'video_p75_watched_actions')),
    video_p95: num(pickVideo(row, 'video_p95_watched_actions')),
    video_p100: num(pickVideo(row, 'video_p100_watched_actions')),
    quality_ranking: row.quality_ranking || '',
    engagement_rate_ranking: row.engagement_rate_ranking || '',
    conversion_rate_ranking: row.conversion_rate_ranking || '',
    leads,
    complete_registration: completeRegistration,
    start_trial: startTrial,
    purchases,
    purchase_value: purchaseValue,
    roas,
    landing_page_views: landingPageViews,
    view_content: viewContent,
    add_to_cart: addToCart,
    initiate_checkout: initiateCheckout,
    cost_per_lead: safeDiv(spend, leads),
    cost_per_registration: safeDiv(spend, completeRegistration),
    cost_per_purchase: safeDiv(spend, purchases),
    actions_json: JSON.stringify(actions),
    pulled_at: pulledAt,
  };
}

function pickVideo(row, field) {
  const arr = row[field];
  if (Array.isArray(arr) && arr.length) return arr[0].value;
  return 0;
}

/** The ordered column list used for the sheet header. */
export const INSIGHT_COLUMNS = [
  'row_key', 'date_start', 'date_stop', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name',
  'ad_id', 'ad_name', 'spend', 'impressions', 'reach', 'frequency', 'clicks', 'ctr', 'cpc', 'cpm',
  'video_p25', 'video_p50', 'video_p75', 'video_p95', 'video_p100',
  'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking',
  'leads', 'complete_registration', 'start_trial', 'purchases', 'purchase_value', 'roas',
  'landing_page_views', 'view_content', 'add_to_cart', 'initiate_checkout',
  'cost_per_lead', 'cost_per_registration', 'cost_per_purchase', 'actions_json', 'pulled_at',
];

export default { flattenInsightRow, INSIGHT_COLUMNS };
