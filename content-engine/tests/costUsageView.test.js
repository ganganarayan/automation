import { describe, it, expect } from 'vitest';
import { costSplit, costBox, lastMonths } from '../src/utils/costUsageView.js';

const now = new Date('2026-11-10T06:00:00Z');
const rows = [
  { tenant_id: 'acme', month: '2026-11', provider: 'openai', usd: 10 },
  { tenant_id: 'acme', month: '2026-11', provider: 'kling', usd: 5 },
  { tenant_id: 'acme', month: '2026-10', provider: 'openai', usd: '2.5' },
];

describe('cost report', () => {
  it('lastMonths walks back across a year end', () => {
    expect(lastMonths(now)).toEqual(['2026-11', '2026-10', '2026-09']);
    expect(lastMonths(new Date('2026-01-15T00:00:00Z'))).toEqual(['2026-01', '2025-12', '2025-11']);
  });
  it('own-key spend is kept off the owner bill', () => {
    const s = costSplit(rows, { acme: { kling: 'tenant', openai: 'platform' } });
    expect(s.acme['2026-11']).toMatchObject({ total: 15, onBill: 10, own: 5 });
    expect(s.acme['2026-10'].onBill).toBe(2.5);
  });
  it('renders INR, plan price and margin', () => {
    const html = costBox([{ id: 'acme', name: 'Acme', plan: 'starter' }], rows, now, { acme: { kling: 'tenant' } });
    expect(html).toContain('Acme');
    expect(html).toContain('$10.00');
    expect(html).toContain('₹880');
    expect(html).toContain('₹2,799');
    expect(html).toContain('69%');
    expect(html).toContain('$5.00 on their own keys');
    expect(html).not.toContain(String.fromCharCode(0x2014));
  });
  it('a failed read says so', () => {
    expect(costBox([], null, now)).toContain('Could not read');
  });
});
