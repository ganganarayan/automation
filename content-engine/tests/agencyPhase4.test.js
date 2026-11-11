import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/settings/index.js', () => ({ settings: { app: { publicBaseUrl: 'https://app.test' } } }));
vi.mock('../src/services/providerFactory.js', () => ({ buildProviders: async () => ({ resolved: { mail: {}, smtp: {} }, mail: { send: async () => ({ ok: true }) } }) }));
vi.mock('../src/repositories/tenantRepository.js', () => ({ findById: async (id) => ({ id, name: 'Acme', parent_id: 'ag' }) }));
vi.mock('../src/repositories/tenantConfigRepository.js', () => ({ findConnectLink: async () => null }));
vi.mock('../src/core/tenantSettings.js', () => ({ forTenant: async () => ({}) }));
vi.mock('../src/services/planService.js', () => ({ tenantInfo: async () => ({ live: true }) }));
vi.mock('../src/providers/publishProvider.js', () => ({ createPostForMeProvider: () => ({}) }));
vi.mock('../src/utils/time.js', () => ({ formatIst: () => '18-11-2026 10:00' }));

const ws = await import('../src/utils/workspaceSpec.js');
const { inviteText } = await import('../src/services/inviteService.js');
const { setupItems, navHtml } = await import('../src/utils/adminNav.js');
const { parseLink } = await import('../src/modules/connectPage.js');

const W = (over) => ({ id: 'c1', name: 'Acme', parentId: 'ag', plan: 'agency', role: 'admin', via: 'member', ...over });

describe('what a person is in a workspace', () => {
  it('admin, staff, owner and viewer', () => {
    expect(ws.workspaceRole({ role: 'super_admin' }, 'c1')).toBe('admin');
    expect(ws.workspaceRole(null, 'c1')).toBe('admin');
    expect(ws.workspaceRole({ role: 'admin', workspaces: [W({ via: 'agency' })] }, 'c1')).toBe('admin');
    expect(ws.workspaceRole({ role: 'admin', workspaces: [W({ role: 'staff' })] }, 'c1')).toBe('staff');
    expect(ws.workspaceRole({ role: 'admin', workspaces: [W()] }, 'c1')).toBe('owner');
    expect(ws.workspaceRole({ role: 'admin', workspaces: [W({ role: 'owner' })] }, 'c1')).toBe('owner');
    expect(ws.workspaceRole({ role: 'admin', workspaces: [W({ role: 'viewer' })] }, 'c1')).toBe('viewer');
    expect(ws.workspaceRole({ role: 'admin', workspaces: [W({ id: 's', parentId: null, plan: 'growth' })] }, 's')).toBe('admin');
    expect(ws.workspaceRole({ role: 'admin', workspaces: [W({ id: 'ag', parentId: null, role: 'staff' })] }, 'ag')).toBe('staff');
  });
  it('a workspace that could not be read is look-only', () => {
    expect(ws.workspaceRole({ role: 'admin', workspaces: [] }, 'c1')).toBe('viewer');
  });
});

describe('the role gate', () => {
  const g = (role, method, path, body) => ws.roleGate({ role, method, path, body });
  it('admins do anything; everyone may look and sign out', () => {
    expect(g('admin', 'POST', '/api/v1/admin/tenants/plan')).toBe('');
    for (const r of ['staff', 'owner', 'viewer']) {
      expect(g(r, 'GET', '/api/v1/admin/settings')).toBe('');
      expect(g(r, 'POST', '/api/v1/admin/logout')).toBe('');
      expect(g(r, 'POST', '/api/v1/admin/workspace')).toBe('');
    }
  });
  it('a viewer changes nothing', () => {
    for (const p of ['/api/v1/admin/instances/x/approve', '/api/v1/admin/settings/save', '/api/v1/admin/funnels/config', '/api/v1/admin/users/add']) {
      expect(g('viewer', 'POST', p)).toContain('look around');
    }
  });
  it('owners and staff work but never touch keys, plans, QA, the waker or the Clients page', () => {
    for (const r of ['owner', 'staff']) {
      expect(g(r, 'POST', '/api/v1/admin/instances/x/approve')).toBe('');
      expect(g(r, 'POST', '/api/v1/admin/instances/x/disapprove')).toBe('');
      expect(g(r, 'POST', '/api/v1/admin/funnels/connect-url')).toBe('');
      expect(g(r, 'POST', '/api/v1/admin/settings/save', { app: 'content-engine' })).toBe('');
      expect(g(r, 'POST', '/api/v1/admin/settings/save', { app: 'api-keys' })).toContain('keys');
      for (const p of ['/api/v1/admin/tenants/plan', '/api/v1/admin/qa/run', '/api/v1/admin/credit/balance', '/api/v1/admin/cloudflare-wake/deploy', '/api/v1/admin/wake-schedule/sync', '/api/v1/admin/users/role', '/api/v1/admin/router/rerun', '/api/v1/admin/clients/add']) {
        expect(g(r, 'POST', p), `${r} ${p}`).toContain('Only an admin');
      }
    }
    expect(g('owner', 'POST', '/api/v1/admin/users/add')).toBe('');
    expect(g('staff', 'POST', '/api/v1/admin/users/add')).toContain('agency admin');
  });
});

describe('who may add whom', () => {
  it('per workspace kind and role', () => {
    expect(ws.kindOf({ parent_id: 'ag' })).toBe('client');
    expect(ws.kindOf({ plan: 'agency' })).toBe('agency');
    expect(ws.kindOf({ plan: 'growth' })).toBe('standalone');
    expect(ws.accessChoices('client', 'admin')).toEqual(['owner', 'viewer']);
    expect(ws.accessChoices('client', 'owner')).toEqual(['viewer']);
    expect(ws.accessChoices('client', 'viewer')).toEqual([]);
    expect(ws.accessChoices('agency', 'admin')).toEqual(['admin', 'staff']);
    expect(ws.accessRole('client', 'owner', 'owner')).toBe('');
    expect(ws.accessRole('client', 'owner', 'viewer')).toBe('viewer');
    expect(ws.accessRole('agency', 'staff', 'admin')).toBe('');
    expect(ws.accessRole('standalone', 'admin', '')).toBe('admin');
  });
});

describe('menu', () => {
  it('Keys and credit only for admins', () => {
    expect(setupItems({ role: 'owner' }).map((i) => i.id)).not.toContain('api-keys');
    expect(setupItems({ role: 'staff' }).map((i) => i.id)).not.toContain('api-keys');
    expect(setupItems().map((i) => i.id)).toContain('api-keys');
    const html = navHtml({ session: { email: 'o@acme.com', role: 'admin', tenantId: 'c1', workspaces: [W({ role: 'viewer' })] } });
    expect(html).not.toContain('#api-keys');
    expect(html).toContain('client viewer');
  });
});

describe('invite email and connect link', () => {
  it('the invite carries the sign-in link, the email and the one-time password', () => {
    const m = inviteText({ workspace: 'Acme', access: 'viewer', email: 'v@acme.com', tempPassword: 'TMP123', base: 'https://app.test/' });
    expect(m.subject).toContain('Acme');
    expect(m.text).toContain('https://app.test/api/v1/admin/login');
    expect(m.text).toContain('v@acme.com');
    expect(m.text).toContain('TMP123');
    expect(m.text).toContain('client viewer');
    expect(m.text).not.toContain(String.fromCharCode(0x2014));
  });
  it('an expired or malformed link opens nothing', () => {
    const now = new Date('2026-11-11T00:00:00Z');
    expect(parseLink('abc|2026-11-12T00:00:00.000Z', now)).toMatchObject({ hash: 'abc' });
    expect(parseLink('abc|2026-11-10T00:00:00.000Z', now)).toBe(null);
    expect(parseLink('abc|nonsense', now)).toBe(null);
    expect(parseLink('', now)).toBe(null);
  });
});
