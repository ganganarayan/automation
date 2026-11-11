import { describe, it, expect } from 'vitest';
import { monthRange, costCsv, rollupMail, rollupDue } from '../src/utils/agencyReport.js';

describe('agency reports', () => {
  it('an IST month as a UTC range', () => {
    const r = monthRange('2026-11');
    expect(r.fromUtc).toBe('2026-10-31T18:30:00.000Z');
    expect(r.toUtc).toBe('2026-11-30T18:30:00.000Z');
    expect(r.label).toBe('11-2026');
    expect(monthRange('nonsense', new Date('2026-11-11T00:00:00Z')).ym).toBe('2026-11');
  });
  it('an empty CSV still has its header', () => {
    expect(costCsv([], {}).split('\r\n')[0]).toContain('"Made (IST)"');
  });
  it('the roll-up skips archived clients and says what waits', () => {
    const m = rollupMail({ agencyName: 'Ag', clients: [{ id: 'a', name: 'A', status: 'active' }, { id: 'b', name: 'B', status: 'archived' }], stats: [{ tenant_id: 'a', needs_you: 2, failed_24h: 1 }], day: '11-11-2026', base: 'https://app.test' });
    expect(m.subject).toBe('Ag: 1 client on 11-11-2026, 2 waiting on you, 1 failed');
    expect(m.html).not.toContain('>B<');
    expect(m.html).toContain('https://app.test/api/v1/admin/clients');
    expect(m.html).not.toContain(String.fromCharCode(0x2014));
    expect(rollupMail({ clients: [] })).toBe(null);
  });
  it('due after 20:00 IST, once a day', () => {
    expect(rollupDue({ now: new Date('2026-11-11T14:29:00Z') }).due).toBe(false);
    expect(rollupDue({ now: new Date('2026-11-11T14:30:00Z') })).toMatchObject({ due: true, day: '2026-11-11', label: '11-11-2026' });
    expect(rollupDue({ now: new Date('2026-11-11T15:00:00Z'), lastDay: '2026-11-11' }).due).toBe(false);
  });
});
