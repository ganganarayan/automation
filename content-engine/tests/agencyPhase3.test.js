import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- fakes ---------------------------------------------------------------------
const tenants = {};
const config = {};
const funnels = {};
const funnelCfg = {};
const userRows = {};
let team = [];
const teamCalls = [];
let nextFunnel = 100;

vi.mock('../src/repositories/tenantRepository.js', () => ({
  findById: async (id) => tenants[id] || null,
  childrenOf: async (id) => Object.values(tenants).filter((t) => t.parent_id === id),
  countChildren: async (id) => Object.values(tenants).filter((t) => t.parent_id === id && t.status !== 'archived').length,
  createNew: async (row) => { tenants[row.id] = { id: row.id, name: row.name, plan: row.plan, parent_id: row.parentId, status: 'active' }; return tenants[row.id]; },
  setStatus: async (id, status) => { tenants[id].status = status; },
  detach: async (id, plan, expiresAt) => { tenants[id] = { ...tenants[id], parent_id: null, plan, expires_at: expiresAt }; },
  list: async () => Object.values(tenants),
}));
const sent = [];
vi.mock('../src/services/providerFactory.js', () => ({ buildProviders: async () => ({ resolved: { emails: { notify: 'boss@ag.com' } }, mail: { send: async (m) => { sent.push(m); return { ok: true }; } } }) }));
vi.mock('../src/repositories/usersRepository.js', () => ({
  findByEmail: async (e) => userRows[e] || null,
  createForTenant: async (u) => { userRows[u.email] = u; return u; },
}));
vi.mock('../src/repositories/tenantConfigRepository.js', () => ({
  getAll: async (t) => ({ ...(config[t] || {}) }),
  get: async (t, k) => (config[t] || {})[k] ?? null,
  set: async (t, k, v) => { config[t] = { ...(config[t] || {}), [k]: v }; },
}));
vi.mock('../src/repositories/funnelsRepository.js', () => ({
  get: async (id) => funnels[id] || null,
  listByTenant: async (t) => Object.values(funnels).filter((f) => f.tenant_id === t),
  create: async ({ tenantId, name }) => { const f = { id: nextFunnel++, tenant_id: tenantId, name }; funnels[f.id] = f; return f; },
  getConfig: async (id) => ({ ...(funnelCfg[id] || {}) }),
  setConfig: async (id, k, v) => { funnelCfg[id] = { ...(funnelCfg[id] || {}), [k]: v }; },
}));
vi.mock('../src/repositories/membershipRepository.js', () => ({
  teamOf: async () => team,
  setTeamMember: async (...a) => { teamCalls.push(a); },
  workspacesFor: async () => [],
}));
vi.mock('../src/repositories/workViewRepository.js', () => ({
  costRows: async ({ tenantIds }) => [
    { tenant_id: 'c1', title: '=HYPERLINK("x")', funnel_name: 'Reels', status: 'posted', created_at: '2026-11-10T14:30:00Z', posted_at: '2026-11-11T02:32:00Z', cost_usd: 0.25, steps: [{ key: 'publish', artifacts: { channels: [{ platform: 'instagram', state: 'ok' }, { platform: 'x', state: 'failed' }] } }], deleted: false },
    { tenant_id: 'c1', title: 'Old', funnel_name: 'Reels', status: 'failed', created_at: '2026-11-05T00:00:00Z', posted_at: null, cost_usd: 0.5, steps: [], deleted: true },
    ...(tenantIds.includes('x1') ? [{ tenant_id: 'x1', title: 'LEAK', cost_usd: 9 }] : []),
  ],
  clientStats: async () => [{ tenant_id: 'c1', posted_today: 2, scheduled_today: 1, needs_you: 3, failed_24h: 1, posts_month: 12, cost_month: 1.5 }],
}));
vi.mock('../src/services/planService.js', () => ({
  clientReason: async (id) => (Object.values(tenants).filter((t) => t.parent_id === id && t.status !== 'archived').length >= 2 ? 'The Agency plan allows 2 clients. Archive one first.' : ''),
  monthUsage: async () => ({ posts: 40, aiVideos: 0 }),
  invalidate: () => {},
}));
vi.mock('../src/core/tenantSettings.js', () => ({ invalidate: () => {} }));
vi.mock('../src/services/accessService.js', () => ({ invalidateWorkspaces: () => {}, keyOk: async () => true, currentSession: async () => null }));
vi.mock('../src/services/cloudflareWakeService.js', () => ({ syncTimes: async () => ({ ok: true }) }));
vi.mock('../src/utils/passwordSpec.js', () => ({ hashPassword: async (p) => `hash:${p}`, hashToken: (t) => `sha:${t}` }));
const invites = [];
vi.mock('../src/services/inviteService.js', () => ({ sendInvite: async (a) => { invites.push(a); return { sent: true }; } }));
vi.mock('../src/settings/index.js', () => ({ settings: { app: { publicBaseUrl: 'https://app.test/' } } }));
vi.mock('../src/core/logger.js', () => ({ childLogger: () => ({ info() {}, warn() {}, error() {} }) }));
vi.mock('../src/utils/time.js', async () => {
  const { DateTime } = await import('luxon');
  return { nowIst: () => DateTime.fromISO('2026-11-11T10:00:00', { zone: 'Asia/Kolkata' }), formatIst: () => '11-11-2026 10:00' };
});

const agency = await import('../src/services/agencyService.js');
const ws = await import('../src/utils/workspaceSpec.js');
const { clientsPage } = await import('../src/modules/agencyPages.js');
const { navHtml } = await import('../src/utils/adminNav.js');

beforeEach(() => {
  for (const o of [tenants, config, funnels, funnelCfg, userRows]) for (const k of Object.keys(o)) delete o[k];
  teamCalls.length = 0;
  tenants.ag = { id: 'ag', name: 'Agency', plan: 'agency', parent_id: null, status: 'active' };
  tenants.other = { id: 'other', name: 'Other agency', plan: 'agency', parent_id: null, status: 'active' };
  tenants.x1 = { id: 'x1', name: 'Not yours', plan: 'agency', parent_id: 'other', status: 'active' };
  tenants.solo = { id: 'solo', name: 'Solo', plan: 'growth', parent_id: null, status: 'active' };
  config.ag = { system_prompt_global: 'House voice', short_music_url: 'https://drive/x', openai_api_key: 'AG_KEY', postforme_api_key: 'AG_PFM', approval_email: 'ag@x.com' };
  funnels[7] = { id: 7, tenant_id: 'ag', name: 'Reels' };
  funnelCfg[7] = { publish_time: '09:00', thumb_tag: 'on', postforme_accounts: '["a1"]', drive_folder_id: 'F', sheet_id: 'S', cta_link: 'https://ag', approval_email: 'ag@x.com', capture_dm_link: 'https://l', landing_page_url: 'https://p' };
  funnels[9] = { id: 9, tenant_id: 'other', name: 'Theirs' };
  team = [
    { email: 'boss@ag.com', tenant_role: 'admin', clients: [] },
    { email: 'sam@ag.com', tenant_role: 'admin', clients: [] },
  ];
});

describe('what Add client copies', () => {
  it('house rules only from the agency settings', () => {
    expect(ws.templateTenantKey('system_prompt_global')).toBe(true);
    expect(ws.templateTenantKey('short_music_url')).toBe(true);
    for (const k of ['openai_api_key', 'postforme_api_key', 'approval_email', 'google_service_account_json', 'daily_time']) expect(ws.templateTenantKey(k), k).toBe(false);
  });
  it('style and times from a funnel, never accounts, files, people or links', () => {
    for (const k of ['publish_time', 'thumb_tag', 'image_size', 'capture_keyword']) expect(ws.templateFunnelKey(k), k).toBe(true);
    for (const k of ['postforme_accounts', 'account_map', 'drive_folder_id', 'sheet_id', 'sheet_tab', 'approval_email', 'cta_link', 'capture_dm_link', 'landing_page_url', 'ig_webhook_url']) expect(ws.templateFunnelKey(k), k).toBe(false);
  });
});

describe('agency admin and team rules', () => {
  const list = ws.mergeWorkspaces([{ id: 'ag', name: 'Agency', parent_id: null, plan: 'agency', role: 'admin', via: 'member' }], 'ag');
  it('only the admin of a top-level Agency runs it', () => {
    expect(ws.agencyAdminOf(list, 'ag')).toBe('ag');
    expect(ws.agencyAdminOf(ws.mergeWorkspaces([{ id: 'ag', plan: 'agency', role: 'staff', via: 'member' }], 'ag'), 'ag')).toBe(null);
    expect(ws.agencyAdminOf(ws.mergeWorkspaces([{ id: 'c1', plan: 'agency', parent_id: 'ag', role: 'admin', via: 'member' }], 'c1'), 'c1')).toBe(null);
    expect(ws.agencyAdminOf(ws.mergeWorkspaces([{ id: 's', plan: 'growth', role: 'admin', via: 'member' }], 's'), 's')).toBe(null);
  });
  it('nobody makes themselves staff, the agency keeps an admin, only team members change', () => {
    expect(ws.teamProblem({ team, email: 'sam@ag.com', role: 'staff', me: 'boss@ag.com' })).toBe('');
    expect(ws.teamProblem({ team, email: 'boss@ag.com', role: 'staff', me: 'boss@ag.com' })).toContain('yourself');
    expect(ws.teamProblem({ team: [team[0]], email: 'boss@ag.com', role: 'staff', me: 'x' })).toContain('at least one admin');
    expect(ws.teamProblem({ team, email: 'who@x.com', role: 'admin', me: 'boss@ag.com' })).toContain('not on your team');
    expect(ws.teamRole('staff')).toBe('staff');
    expect(ws.teamRole('owner')).toBe('admin');
  });
  it('the menu shows Clients only to an agency admin', () => {
    expect(navHtml({ session: { email: 'a', agencyId: 'ag', workspaces: [] } })).toContain('/api/v1/admin/clients');
    expect(navHtml({ session: { email: 'a', agencyId: null, workspaces: [] } })).not.toContain('/api/v1/admin/clients');
  });
});

describe('Add client', () => {
  it('makes the workspace under the agency, its owner, its Daily time and copies the template', async () => {
    const out = await agency.addClient('ag', { id: 'acme', name: 'Acme', owner_email: 'Owner@Acme.com', daily_time: '7:30', template: '7' });
    expect(tenants.acme).toMatchObject({ parent_id: 'ag', plan: 'agency' });
    expect(userRows['owner@acme.com']).toMatchObject({ tenantId: 'acme', role: 'admin' });
    expect(out.tempPassword.length).toBeGreaterThan(8);
    expect(config.acme.daily_time).toBe('07:30');
    expect(config.acme.system_prompt_global).toBe('House voice');
    expect(config.acme.short_music_url).toBe('https://drive/x');
    expect(config.acme.openai_api_key).toBeUndefined();
    expect(config.acme.postforme_api_key).toBeUndefined();
    const made = Object.values(funnels).find((f) => f.tenant_id === 'acme');
    expect(made.name).toBe('Reels');
    expect(funnelCfg[made.id]).toEqual({ publish_time: '09:00', thumb_tag: 'on' });
    expect(out.copied).toEqual({ settings: 2, funnel: 'Reels' });
    expect(out.emailed).toBe(true);
    expect(invites.at(-1)).toMatchObject({ tenantId: 'acme', email: 'owner@acme.com', access: 'owner' });
  });
  it('never copies another agency\'s funnel', async () => {
    const out = await agency.addClient('ag', { id: 'acme', name: 'Acme', owner_email: 'o@acme.com', template: '9' });
    expect(out.copied.funnel).toBe(null);
  });
  it('refuses a full agency, a taken id or email, a bad id, and a workspace that is not an agency', async () => {
    tenants.c1 = { id: 'c1', parent_id: 'ag', status: 'active' };
    tenants.c2 = { id: 'c2', parent_id: 'ag', status: 'active' };
    await expect(agency.addClient('ag', { id: 'acme', owner_email: 'o@acme.com' })).rejects.toThrow('allows 2 clients');
    delete tenants.c2;
    await expect(agency.addClient('ag', { id: 'solo', owner_email: 'o@acme.com' })).rejects.toThrow('taken');
    userRows['o@acme.com'] = { email: 'o@acme.com' };
    await expect(agency.addClient('ag', { id: 'acme', owner_email: 'o@acme.com' })).rejects.toThrow('already has an account');
    await expect(agency.addClient('ag', { id: 'Bad Id', owner_email: 'n@acme.com' })).rejects.toThrow('Client id');
    await expect(agency.addClient('solo', { id: 'acme', owner_email: 'n@acme.com' })).rejects.toThrow('not an agency');
    await expect(agency.addClient('x1', { id: 'acme', owner_email: 'n@acme.com' })).rejects.toThrow('not an agency');
  });
});

describe('Archive and Bring back', () => {
  it('archives its own client only', async () => {
    tenants.c1 = { id: 'c1', parent_id: 'ag', status: 'active' };
    await agency.setArchived('ag', 'c1', true);
    expect(tenants.c1.status).toBe('archived');
    await expect(agency.setArchived('ag', 'x1', true)).rejects.toThrow('not yours');
    expect(tenants.x1.status).toBe('active');
  });
  it('bringing one back is refused when the agency is full', async () => {
    tenants.c1 = { id: 'c1', parent_id: 'ag', status: 'archived' };
    tenants.c2 = { id: 'c2', parent_id: 'ag', status: 'active' };
    tenants.c3 = { id: 'c3', parent_id: 'ag', status: 'active' };
    await expect(agency.setArchived('ag', 'c1', false)).rejects.toThrow('allows 2 clients');
    delete tenants.c3;
    await agency.setArchived('ag', 'c1', false);
    expect(tenants.c1.status).toBe('active');
  });
});

describe('connect link', () => {
  it('stores only the hash, for its own client, valid 7 days', async () => {
    tenants.c1 = { id: 'c1', parent_id: 'ag', status: 'active' };
    const out = await agency.connectLink('ag', 'c1');
    const token = out.url.split('/connect/')[1];
    expect(out.url.startsWith('https://app.test/api/v1/connect/')).toBe(true);
    expect(token.length).toBeGreaterThan(20);
    const [hash, iso] = config.c1.connect_link.split('|');
    expect(hash).toBe(`sha:${token}`);
    expect(new Date(iso) - Date.now()).toBeGreaterThan(6.9 * 86400000);
    await expect(agency.connectLink('ag', 'x1')).rejects.toThrow('not yours');
  });
});

describe('cost CSV, move out, roll-up', () => {
  it('the CSV covers the agency and its own clients only, dates in IST, totals per client, no formulas', async () => {
    tenants.c1 = { id: 'c1', name: 'Acme', parent_id: 'ag', status: 'active' };
    const out = await agency.costCsvFor('ag', '2026-11');
    expect(out.filename).toBe('ag-costs-11-2026.csv');
    expect(out.csv).not.toContain('LEAK');
    expect(out.csv).toContain('"10-11-2026 20:00"');
    expect(out.csv).toContain('"11-11-2026 08:02"');
    expect(out.csv).toContain('"instagram","x","0.2500"');
    expect(out.csv).toContain('"failed (deleted)"');
    expect(out.csv).toContain('"Acme","TOTAL","","","","","","","0.7500"');
    expect(out.csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
  it('moves its own client out onto Starter or Growth for a week, never another agency\'s', async () => {
    tenants.c1 = { id: 'c1', name: 'Acme', parent_id: 'ag', status: 'active', plan: 'agency' };
    const out = await agency.detachClient('ag', 'c1', 'growth');
    expect(tenants.c1).toMatchObject({ parent_id: null, plan: 'growth' });
    expect(new Date(tenants.c1.expires_at) - Date.now()).toBeGreaterThan(6.9 * 86400000);
    expect(out.plan).toBe('growth');
    tenants.c2 = { id: 'c2', parent_id: 'ag', status: 'active' };
    expect((await agency.detachClient('ag', 'c2', 'agency')).plan).toBe('brand');
    await expect(agency.detachClient('ag', 'x1')).rejects.toThrow('not yours');
  });
  it('one roll-up a day after 20:00 IST to the agency', async () => {
    tenants.c1 = { id: 'c1', name: 'Acme', parent_id: 'ag', status: 'active', plan: 'agency' };
    sent.length = 0;
    await agency.rollupAll(new Date('2026-11-11T13:00:00Z'));
    expect(sent.length).toBe(0);
    await agency.rollupAll(new Date('2026-11-11T15:00:00Z'));
    // One per agency: ag and other (each with one client).
    expect(sent.length).toBe(2);
    const mine = sent.find((m) => m.subject.startsWith('Agency:'));
    expect(mine.to).toBe('boss@ag.com');
    expect(mine.subject).toContain('Agency: 1 client on 11-11-2026');
    expect(mine.html).toContain('Acme');
    expect(mine.html).not.toContain('Not yours');
    await agency.rollupAll(new Date('2026-11-11T16:00:00Z'));
    expect(sent.length).toBe(2);
  });
});

describe('team', () => {
  it('staff get only this agency\'s clients', async () => {
    tenants.c1 = { id: 'c1', parent_id: 'ag', status: 'active' };
    const out = await agency.setTeam('ag', 'boss@ag.com', { email: 'sam@ag.com', role: 'staff', clients: ['c1', 'x1', 'ag'] });
    expect(out.clients).toEqual(['c1']);
    expect(teamCalls[0]).toEqual(['ag', 'sam@ag.com', 'staff', ['c1']]);
  });
  it('refuses demoting yourself', async () => {
    await expect(agency.setTeam('ag', 'boss@ag.com', { email: 'boss@ag.com', role: 'staff' })).rejects.toThrow('yourself');
  });
});

describe('the Clients page', () => {
  it('lists clients with their numbers, the pool and the forms, without tenant fields', async () => {
    tenants.c1 = { id: 'c1', name: 'Acme', parent_id: 'ag', status: 'active', plan: 'agency' };
    tenants.c2 = { id: 'c2', name: 'Old', parent_id: 'ag', status: 'archived', plan: 'agency' };
    config.c1 = { daily_time: '18:30' };
    const data = await agency.overview('ag');
    expect(data.active).toBe(1);
    const html = clientsPage({ ...data, limit: 10, postsLimit: 300 }, { email: 'boss@ag.com', tenantId: 'c1' });
    expect(html).toContain('1 of 10 clients');
    expect(html).toContain('40 of 300 posts this month');
    expect(html).toContain('18:30');
    expect(html).toContain('2 posted, 1 to go');
    expect(html).toContain('🟡 3');
    expect(html).toContain('🔴 1');
    expect(html).toContain('$1.50');
    expect(html).toContain('Bring back');
    expect(html).toContain('you are here');
    expect(html).toContain('name="workspace" value="c1"');
    expect(html).not.toMatch(/name="tenant"|tenant:|funnel_id|funnelId/);
    expect(html).not.toContain(String.fromCharCode(0x2014));
  });
});
