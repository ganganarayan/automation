import { describe, it, expect, vi } from 'vitest';

const fakeSettings = {
  google: { serviceAccount: { client_email: 'sa@platform' } },
  sheets: {}, drive: {},
  postforme: { apiKey: 'OWNER_PFM', gitaAccounts: [], vidapulseAccounts: [], gitaVideoAccounts: [], accountMap: {} },
  emails: {}, links: {},
  openai: { apiKey: 'OWNER_OPENAI', imageModel: 'gpt-image-1', textModel: 'gpt-5-mini' },
  gemini: { apiKey: 'OWNER_GEMINI', imageModel: 'gemini-img' },
  video: { json2videoApiKey: 'OWNER_J2V' },
  instagram: {}, smtp: { port: 587 }, modules: {},
};
vi.mock('../src/settings/index.js', () => ({ settings: fakeSettings, default: fakeSettings }));

// ag: an agency with its own keys; c1, c2 its clients (c2 has its own OpenAI key).
// ag2: an agency with no keys; c3 its client.
const tenants = {
  default: { id: 'default', plan: 'custom' },
  ag: { id: 'ag', plan: 'agency', parent_id: null, status: 'active', expires_at: null },
  c1: { id: 'c1', plan: 'agency', parent_id: 'ag', status: 'active', expires_at: null },
  c2: { id: 'c2', plan: 'agency', parent_id: 'ag', status: 'active', expires_at: null },
  ag2: { id: 'ag2', plan: 'agency', parent_id: null, status: 'active', expires_at: new Date(Date.now() - 86400000).toISOString() },
  c3: { id: 'c3', plan: 'agency', parent_id: 'ag2', status: 'active', expires_at: null },
};
const overrides = {
  default: {},
  ag: { openai_api_key: 'AG_OPENAI', postforme_api_key: 'AG_PFM' },
  c1: {},
  c2: { openai_api_key: 'C2_OPENAI' },
  ag2: {},
  c3: {},
};
vi.mock('../src/repositories/tenantConfigRepository.js', () => ({
  getAll: async (t) => ({ ...(overrides[t] || {}) }),
  get: async () => '',
  set: async () => {},
}));
vi.mock('../src/repositories/tenantRepository.js', () => ({
  list: async () => Object.values(tenants),
  findById: async (id) => tenants[id] || null,
  childrenOf: async (id) => Object.values(tenants).filter((t) => t.parent_id === id),
  countChildren: async (id) => Object.values(tenants).filter((t) => t.parent_id === id).length,
}));
const sql = [];
vi.mock('../src/core/db.js', () => ({ query: async (text, params) => { sql.push(params); return { rows: [{ n: 0 }] }; } }));

const ts = await import('../src/core/tenantSettings.js');
const plan = await import('../src/services/planService.js');
const ws = await import('../src/utils/workspaceSpec.js');
const { switcherHtml } = await import('../src/utils/adminNav.js');
const { limitsFor, overLimit } = await import('../src/utils/planSpec.js');

describe('which workspaces a person may work in', () => {
  const rows = [
    { id: 'c1', name: 'Client One', parent_id: 'ag', via: 'agency' },
    { id: 'ag', name: 'Agency', parent_id: null, via: 'member' },
    { id: 'c1', name: 'Client One', parent_id: 'ag', via: 'member' },
    { id: 'c2', name: 'Alpha', parent_id: 'ag', via: 'agency' },
  ];
  it('home first, each workspace once, a direct membership wins', () => {
    const list = ws.mergeWorkspaces(rows, 'ag');
    expect(list.map((w) => w.id)).toEqual(['ag', 'c2', 'c1']);
    expect(list.find((w) => w.id === 'c1').via).toBe('member');
  });
  it('the switcher pick holds only while it may be entered', () => {
    const list = ws.mergeWorkspaces(rows, 'ag');
    expect(ws.pickWorkspace({ home: 'ag', active: 'c1', workspaces: list })).toBe('c1');
    expect(ws.pickWorkspace({ home: 'ag', active: 'zeta', workspaces: list })).toBe('ag');
    expect(ws.pickWorkspace({ home: 'ag', active: null, workspaces: list })).toBe('ag');
    expect(ws.pickWorkspace({ home: 'ag', active: 'c1', workspaces: [] })).toBe('ag');
    expect(ws.mayEnter(list, '')).toBe(false);
  });
  it('the menu shows a switcher only with two or more workspaces', () => {
    expect(switcherHtml({ tenantId: 'ag', workspaces: [{ id: 'ag', name: 'Agency', parentId: null }] })).toBe('');
    const html = switcherHtml({ tenantId: 'c1', workspaces: ws.mergeWorkspaces(rows, 'ag') });
    expect(html).toContain('action="/api/v1/admin/workspace"');
    expect(html).toContain('name="workspace"');
    expect(html).toContain('<option value="c1" selected>Client One (client)</option>');
    expect(html).not.toContain('name="tenant"');
  });
});

describe('making clients and changing plans', () => {
  const agency = { id: 'ag', plan: 'agency', parent_id: null };
  it('only a top-level Agency may have clients, up to its limit', () => {
    expect(limitsFor('agency').clients).toBe(10);
    expect(ws.clientProblem({ parent: agency, clients: 9, limit: 10 })).toBe('');
    expect(ws.clientProblem({ parent: agency, clients: 10, limit: 10 })).toContain('10 clients');
    expect(ws.clientProblem({ parent: { ...agency, plan: 'growth' }, clients: 0, limit: 0 })).toContain('Agency plan');
    expect(ws.clientProblem({ parent: { ...agency, parent_id: 'x' }, clients: 0, limit: 10 })).toContain('cannot have clients');
    expect(ws.clientProblem({ parent: null })).toContain('does not exist');
  });
  it('a client follows its agency; an agency with clients keeps the Agency plan', () => {
    expect(ws.planChangeProblem({ tenant: { plan: 'agency', parent_id: 'ag' }, plan: 'growth' })).toContain("agency's plan");
    expect(ws.planChangeProblem({ tenant: agency, plan: 'growth', clients: 2 })).toContain('2 clients');
    expect(ws.planChangeProblem({ tenant: agency, plan: 'growth', clients: 0 })).toBe('');
    expect(ws.planChangeProblem({ tenant: agency, plan: 'custom', clients: 0 })).toBe('');
  });
  it('Agency has no cap on funnels or channels', () => {
    expect(overLimit('agency', 'channels', 0, 40)).toBe('');
    expect(overLimit('agency', 'funnels', 50, 1)).toBe('');
    expect(overLimit('starter', 'clients', 0, 1)).toContain('no clients');
  });
});

describe('keys: a client uses its own, else its agency\'s, never the owner\'s', () => {
  it('pure rule', () => {
    expect(ts.providerKey('k', { own: {}, owner: { k: 'O' }, envValue: 'E', agency: { k: 'A' } })).toEqual(['A', 'tenant']);
    expect(ts.providerKey('k', { own: {}, owner: { k: 'O' }, envValue: 'E', agency: {} })).toEqual(['', 'none']);
    expect(ts.providerKey('k', { own: { k: 'M' }, owner: { k: 'O' }, agency: { k: 'A' } })).toEqual(['M', 'tenant']);
  });
  it('a client on its agency\'s key', async () => {
    const r = await ts.forTenant('c1');
    expect(r.openai.apiKey).toBe('AG_OPENAI');
    expect(r.keyOwners.openai).toBe('tenant');
    expect(JSON.stringify(r)).not.toContain('OWNER_OPENAI');
  });
  it('a client with a key of its own', async () => {
    const r = await ts.forTenant('c2');
    expect(r.openai.apiKey).toBe('C2_OPENAI');
  });
  it('a client of an agency with no keys gets none, not the owner\'s', async () => {
    const r = await ts.forTenant('c3');
    expect(r.openai.apiKey).toBe('');
    expect(r.gemini.apiKey).toBe('');
    expect(r.keyOwners.openai).toBe('none');
  });
});

describe('Post for Me: clients stay apart on the agency\'s key', () => {
  it('a client posts on its agency\'s key, scoped to its own accounts', async () => {
    const p = await ts.postformeFor('c1', overrides.c1);
    expect(p.key).toBe('AG_PFM');
    expect(p.scope).toMatchObject({ tenantId: 'c1', owner: false, keyTenant: 'ag' });
    expect(p.shared).toBe(false);
  });
  it('the agency on its own key does not own its clients\' accounts', async () => {
    const p = await ts.postformeFor('ag', overrides.ag);
    expect(p.key).toBe('AG_PFM');
    expect(p.scope).toMatchObject({ tenantId: 'ag', owner: true });
    expect(p.scope.others.sort()).toEqual(['c1', 'c2']);
  });
  it('a client of an agency with no Post for Me key uses the owner\'s shared key, scoped', async () => {
    const p = await ts.postformeFor('c3', overrides.c3);
    expect(p.key).toBe('OWNER_PFM');
    expect(p.scope).toMatchObject({ tenantId: 'c3', owner: false, keyTenant: 'default' });
  });
});

describe('plan pool and expiry', () => {
  it('a client is on its agency\'s plan and counts against the same pool', async () => {
    plan.invalidate();
    const info = await plan.tenantInfo('c1');
    expect(info.plan).toBe('agency');
    expect(info.agencyId).toBe('ag');
    expect(info.pool.sort()).toEqual(['ag', 'c1', 'c2']);
    expect((await plan.tenantInfo('ag')).pool.sort()).toEqual(['ag', 'c1', 'c2']);
    sql.length = 0;
    await plan.monthUsage('c2');
    expect(sql[0][0].sort()).toEqual(['ag', 'c1', 'c2']);
  });
  it('a client of an expired agency is not live, with the agency\'s end date', async () => {
    plan.invalidate();
    const info = await plan.tenantInfo('c3');
    expect(info.live).toBe(false);
    expect(info.reason).toBe('expired');
    expect(info.expiresAt).toBe(tenants.ag2.expires_at);
    expect(await plan.limitReason('c3', 'posts', { used: 0 })).toContain('cannot post');
  });
  it('the 11th client is refused', async () => {
    expect(await plan.clientReason('ag')).toBe('');
    expect(await plan.clientReason('c1')).toContain('cannot have clients');
    expect(await plan.clientReason('nope')).toContain('does not exist');
  });
});
