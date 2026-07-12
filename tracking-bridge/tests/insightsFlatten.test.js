import { describe, it, expect } from 'vitest';
import { flattenInsightRow, INSIGHT_COLUMNS } from '../src/services/insightsFlatten.js';

describe('flattenInsightRow', () => {
  const row = {
    date_start: '2026-07-10',
    date_stop: '2026-07-10',
    ad_id: 'ad_1',
    ad_name: 'Ad One',
    spend: '100',
    impressions: '1000',
    clicks: '50',
    actions: [
      { action_type: 'lead', value: '5' },
      { action_type: 'purchase', value: '2' },
      { action_type: 'landing_page_view', value: '40' },
    ],
    action_values: [{ action_type: 'purchase', value: '400' }],
  };

  it('derives a stable row_key', () => {
    expect(flattenInsightRow(row).row_key).toBe('2026-07-10|ad_1');
  });

  it('sums actions into derived metrics', () => {
    const f = flattenInsightRow(row);
    expect(f.leads).toBe(5);
    expect(f.purchases).toBe(2);
    expect(f.purchase_value).toBe(400);
    expect(f.landing_page_views).toBe(40);
  });

  it('computes roas and cost-per metrics', () => {
    const f = flattenInsightRow(row);
    expect(f.roas).toBe(4); // 400 / 100
    expect(f.cost_per_lead).toBe(20); // 100 / 5
    expect(f.cost_per_purchase).toBe(50); // 100 / 2
  });

  it('avoids division by zero', () => {
    const f = flattenInsightRow({ ...row, actions: [], action_values: [] });
    expect(f.cost_per_lead).toBe(0);
    expect(f.roas).toBe(0);
  });

  it('produces every declared column', () => {
    const f = flattenInsightRow(row);
    for (const col of INSIGHT_COLUMNS) expect(f).toHaveProperty(col);
  });
});
