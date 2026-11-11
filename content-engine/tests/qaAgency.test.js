import { describe, it, expect, vi, beforeEach } from 'vitest';

const tenants = {};
const funnels = {};
let nextFunnel = 1;
let leakKey = false;

vi.mock('../src/repositories/tenantRepository.js', () => ({
  findById: async (id) => tenants[id] || null,
  createNew: async ({ id, name, plan, expiresAt, parentId }) => {
    tenants[id] = { id, name, plan, expires_at: expiresAt, parent_id: parentId, status: 'active' };
    return tenants[id];
  },
  childrenOf: async (id) => Object.values(tenants).filter((t) => t.parent_id === id),
  activeIds: async () => Object.values(tenants).filter((t) => {
    const live = (x) => x && x.status === 'active' && (!x.expires_at || new Date(x.expires_at) > new Date());
    return live(t) && (!t.parent_id || live(tenants[t.parent_id]));
  }).map((t) => t.id),
}));
vi.mock('../src/repositories/funnelsRepository.js', () => ({
  findByName: async (tenantId, name) => Object.values(funnels).find((f) => f.tenantId === tenantId && f.name === name) || null,
  create: async ({ tenantId, name }) => { const id = nextFunnel++; funnels[id] = { id, tenantId, name, active: true }; return funnels[id]; },
  setActive: async (id, active) => { funnels[id].active = active; },
}));
vi.mock('../src/repositories/ownershipRepository.js', () => ({
  tenantOf: async (kind, id) => (kind === 'funnel' && funnels[id] ? funnels[id].tenantId : null),
}));
vi.mock('../src/services/accessService.js', () => ({ currentSession: async () => null, adminKeyOk: () => false }));
vi.mock('../src/core/tenantSettings.js', () => ({
  invalidate: () => {},
  forTenant: async (id) => (id === 'default'
    ? { keyOwners: { openai: 'platform' }, postformeKey: 'owner-pfm' }
    : { keyOwners: { openai: leakKey ? 'platform' : 'tenant', google: 'platform' }, postformeKey: 'ag-pfm', postformeScope: { tenantId: id, owner: false, keyTenant: 'qa-agency' } }),
}));
vi.mock('../src/services/planService.js', () => {
  const live = (t) => !!t && t.status === 'active' && (!t.expires_at || new Date(t.expires_at) > new Date());
  return {
    invalidate: () => {},
    clientReason: async () => '',
    tenantInfo: async (id) => {
      const t = tenants[id];
      const top = t.parent_id ? tenants[t.parent_id] : t;
      const pool = [top.id, ...Object.values(tenants).filter((x) => x.parent_id === top.id).map((x) => x.id)];
      return { plan: top.plan, pool, live: live(t) && live(top), agencyId: top.id };
    },
  };
});

const { agencyChecks, OTHER_AGENCY, EXPIRED_AGENCY } = await import('../src/services/qaAgency.js');

beforeEach(() => {
  for (const k of Object.keys(tenants)) delete tenants[k];
  for (const k of Object.keys(funnels)) delete funnels[k];
  leakKey = false;
});

describe('QA phase 6: agency clients', () => {
  it('skips a workspace that is not a top-level agency', async () => {
    tenants['qa-growth'] = { id: 'qa-growth', plan: 'growth', status: 'active' };
    const rows = await agencyChecks('qa-growth');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ group: 'Phase 6 agency', status: 'skip' });
    tenants[OTHER_AGENCY] = { id: OTHER_AGENCY, plan: 'agency', status: 'active' };
    expect((await agencyChecks(OTHER_AGENCY))[0].status).toBe('skip');
    expect((await agencyChecks('missing'))[0].status).toBe('skip');
  });

  it('makes its fixtures once and every check passes', async () => {
    tenants['qa-agency'] = { id: 'qa-agency', name: 'QA agency', plan: 'agency', status: 'active', parent_id: null };
    const rows = await agencyChecks('qa-agency');
    const bad = rows.filter((r) => r.status !== 'ok');
    expect(bad).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(tenants['qa-agency-c1'].parent_id).toBe('qa-agency');
    expect(tenants[`${EXPIRED_AGENCY}-c1`].parent_id).toBe(EXPIRED_AGENCY);
    const sib = Object.values(funnels);
    expect(sib).toHaveLength(1);
    expect(sib[0]).toMatchObject({ tenantId: 'qa-agency-c2', active: false });
    await agencyChecks('qa-agency');
    expect(Object.values(funnels)).toHaveLength(1);
    for (const r of rows) expect(r.detail).not.toContain(String.fromCharCode(0x2014));
  });

  it('fails when a client would use the owner\'s key', async () => {
    tenants['qa-agency'] = { id: 'qa-agency', name: 'QA agency', plan: 'agency', status: 'active', parent_id: null };
    leakKey = true;
    const rows = await agencyChecks('qa-agency');
    const keys = rows.find((r) => r.name === 'Client keys');
    expect(keys.status).toBe('fail');
    expect(keys.detail).toContain('openai');
  });
});
