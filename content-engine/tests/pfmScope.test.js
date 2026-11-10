import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
let routes = {};
vi.mock('../src/core/httpClient.js', () => ({
  request: async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const [k, fn] of Object.entries(routes)) if (url.includes(k)) return fn(url, opts);
    return { ok: false, status: 404, data: null, text: 'nope' };
  },
}));

const {
  scopeFor, ownsAccount, filterAccounts, connectExternalId, ownsPost, tenantOfExternalId,
  hookTenant, webhookMayAct, planShare, usageMonth, monthLabel,
} = await import('../src/utils/pfmScope.js');
const { createPostForMeProvider, NotYourAccountError } = await import('../src/providers/publishProvider.js');
const { usageBox } = await import('../src/utils/pfmUsageView.js');

const ACCOUNTS = [
  { id: 'a1', platform: 'facebook', external_id: null },          // connected before tenants
  { id: 'a2', platform: 'instagram', external_id: 'default' },
  { id: 'b1', platform: 'facebook', external_id: 'acme' },
  { id: 'b2', platform: 'threads', external_id: 'acme:threads-delete' },
  { id: 'c1', platform: 'x', external_id: 'zeta' },
  { id: 'c2', platform: 'x', external_id: 'acmeco' },             // a prefix lookalike, not acme's
];

const owner = scopeFor({ tenantId: 'default', ownerKey: 'K', otherTenants: ['default', 'acme', 'zeta', 'acmeco'] });
const acme = scopeFor({ tenantId: 'acme', ownerKey: 'K' });

describe('pfmScope: who owns an account', () => {
  it('a tenant with a key of its own has no scope (the whole account is its own)', () => {
    expect(scopeFor({ tenantId: 'acme', ownKey: 'MINE', ownerKey: 'K' })).toBeNull();
    expect(ownsAccount(null, ACCOUNTS[4])).toBe(true);
  });

  it('a tenant on the shared key, or typing the same key, is scoped', () => {
    expect(acme).toMatchObject({ tenantId: 'acme', owner: false, keyTenant: 'default' });
    expect(scopeFor({ tenantId: 'acme', ownKey: 'K', ownerKey: 'K' })).toMatchObject({ tenantId: 'acme', owner: false });
  });

  it('tenant of an external_id', () => {
    expect(tenantOfExternalId('acme:threads')).toBe('acme');
    expect(tenantOfExternalId(null)).toBe('');
  });

  it('a tenant sees only its own accounts, never a prefix lookalike', () => {
    expect(filterAccounts(acme, ACCOUNTS).map((a) => a.id)).toEqual(['b1', 'b2']);
  });

  it('the owner keeps its old untagged accounts and never sees another tenant\'s', () => {
    expect(filterAccounts(owner, ACCOUNTS).map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('the owner fails closed when the tenant list is unknown', () => {
    const blind = scopeFor({ tenantId: 'default', ownerKey: 'K', otherTenants: null });
    expect(filterAccounts(blind, [...ACCOUNTS, { id: 'z', external_id: 'legacy-thing' }]).map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('an untagged account is never another tenant\'s', () => {
    expect(ownsAccount(acme, ACCOUNTS[0])).toBe(false);
  });
});

describe('pfmScope: connect links', () => {
  it('a new connect carries the tenant id', () => {
    expect(connectExternalId(acme, '')).toBe('acme');
    expect(connectExternalId(owner, '')).toBe('default');
  });
  it('a reconnect keeps the tenant\'s own tagged id', () => {
    expect(connectExternalId(acme, 'acme:threads-delete')).toBe('acme:threads-delete');
  });
  it('another tenant\'s id is replaced with the caller\'s', () => {
    expect(connectExternalId(acme, 'zeta')).toBe('acme');
    expect(connectExternalId(owner, 'zeta')).toBe('default');
  });
  it('an own key keeps whatever was asked', () => {
    expect(connectExternalId(null, 'x:1')).toBe('x:1');
  });
});

describe('pfmScope: posts and webhooks', () => {
  it('a post tagged for another tenant is refused, an untagged one is judged by the app records', () => {
    expect(ownsPost(acme, { external_id: 'zeta' })).toBe(false);
    expect(ownsPost(acme, { external_id: 'acme' })).toBe(true);
    expect(ownsPost(acme, { external_id: null })).toBe(true);
  });
  it('the shared key has one webhook, the owner\'s', () => {
    expect(hookTenant('acme', acme)).toBe('default');
    expect(hookTenant('acme', null)).toBe('acme');
    expect(hookTenant('default', owner)).toBe('default');
  });
  it('a webhook acts only for its own tenant, or the owner\'s hook for a shared-key tenant', () => {
    expect(webhookMayAct({ hookTenantId: 'acme', rowTenantId: 'acme', rowScope: acme })).toBe(true);
    expect(webhookMayAct({ hookTenantId: 'default', rowTenantId: 'acme', rowScope: acme })).toBe(true);
    expect(webhookMayAct({ hookTenantId: 'zeta', rowTenantId: 'acme', rowScope: acme })).toBe(false);
    // acme on a key of its own: the owner's hook must not act for it.
    expect(webhookMayAct({ hookTenantId: 'default', rowTenantId: 'acme', rowScope: null })).toBe(false);
    expect(webhookMayAct({ hookTenantId: 'acme', rowTenantId: '', rowScope: null })).toBe(false);
  });
});

describe('publishProvider under a tenant scope', () => {
  beforeEach(() => {
    calls.length = 0;
    routes = {
      '/social-accounts?': (url) => {
        const q = new URL(url).searchParams;
        const offset = Number(q.get('offset')), limit = Number(q.get('limit'));
        // 230 accounts: pages past the old limit of 50.
        const all = Array.from({ length: 230 }, (_, i) => ({ id: `x${i}`, platform: 'facebook', external_id: i % 2 ? 'acme' : 'zeta' }));
        const data = all.slice(offset, offset + limit);
        return { ok: true, status: 200, data: { data, meta: { total: all.length, offset, limit, next: offset + limit < all.length ? 'next' : null } } };
      },
      '/social-accounts/x2': () => ({ ok: true, status: 200, data: { id: 'x2', external_id: 'zeta' } }),
      '/social-accounts/x1': () => ({ ok: true, status: 200, data: { id: 'x1', external_id: 'acme' } }),
      '/social-accounts/auth-url': (url, opts) => ({ ok: true, status: 200, data: { url: 'https://connect', echo: opts.body } }),
      '/social-post-results': () => ({ ok: true, status: 200, data: { data: [{ social_account_id: 'x1', success: true }, { social_account_id: 'x2', success: true }] } }),
      '/social-posts/p-zeta': () => ({ ok: true, status: 200, data: { id: 'p-zeta', external_id: 'zeta' } }),
      '/social-posts': (url, opts) => ({ ok: true, status: 200, data: { id: 'new', body: opts.body } }),
    };
  });

  const pfm = () => createPostForMeProvider({ apiKey: 'K', scope: acme }, null);

  it('lists every page and keeps only the tenant\'s accounts', async () => {
    const out = await pfm().listAccounts();
    expect(out.data).toHaveLength(115);
    expect(out.data.every((a) => a.external_id === 'acme')).toBe(true);
    expect(calls.filter((c) => c.url.includes('/social-accounts?')).length).toBe(3);
  });

  it('refuses to post to another tenant\'s account', async () => {
    await expect(pfm().createPost({ accountIds: ['x1', 'x2'], caption: 'hi' })).rejects.toBeInstanceOf(NotYourAccountError);
    expect(calls.some((c) => c.url.endsWith('/social-posts') && c.opts.method === 'POST')).toBe(false);
  });

  it('posts to its own accounts and tags the post with the tenant', async () => {
    const out = await pfm().createPost({ accountIds: ['x1', 'x3'], caption: 'hi' });
    expect(out.body.external_id).toBe('acme');
    expect(out.body.social_accounts).toEqual(['x1', 'x3']);
  });

  it('getAccount refuses another tenant\'s account', async () => {
    await expect(pfm().getAccount('x2')).rejects.toBeInstanceOf(NotYourAccountError);
    await expect(pfm().getAccount('x1')).resolves.toMatchObject({ id: 'x1' });
  });

  it('post results show only the tenant\'s channels', async () => {
    const rows = await pfm().postResults('p1');
    expect(rows.map((r) => r.social_account_id)).toEqual(['x1']);
  });

  it('getPost and deletePost refuse a post tagged for another tenant', async () => {
    await expect(pfm().getPost('p-zeta')).rejects.toBeInstanceOf(NotYourAccountError);
    await expect(pfm().deletePost('p-zeta')).rejects.toBeInstanceOf(NotYourAccountError);
    expect(calls.some((c) => c.opts.method === 'DELETE')).toBe(false);
  });

  it('connect links carry the tenant external_id', async () => {
    const out = await pfm().authUrl({ platform: 'instagram' });
    expect(out.echo.external_id).toBe('acme');
    const re = await pfm().authUrl({ platform: 'threads', externalId: 'zeta' });
    expect(re.echo.external_id).toBe('acme');
  });

  it('an own key is not filtered', async () => {
    const out = await createPostForMeProvider({ apiKey: 'MINE', scope: null }, null).listAccounts();
    expect(out.data).toHaveLength(230);
  });
});

describe('usage per tenant', () => {
  it('IST month and its label', () => {
    expect(usageMonth('2026-10-31T19:00:00Z')).toBe('2026-11'); // 00:30 IST on 01-11-2026
    expect(monthLabel('2026-11')).toBe('11-2026');
  });

  it('splits the shared plan by successful posts', () => {
    const p = planShare({ default: 600, acme: 300, zeta: 100 });
    expect(p.total).toBe(1000);
    expect(p.overLimit).toBe(false);
    expect(p.share.acme).toMatchObject({ posts: 300, pct: 30, usd: 3 });
    expect(planShare({ a: 1001 }).overLimit).toBe(true);
    expect(planShare({}).total).toBe(0);
  });

  it('the Tenants usage box: per month, own-key tenants off the bill, months as MM-YYYY', () => {
    const html = usageBox(
      [{ id: 'default', name: 'Owner' }, { id: 'acme', name: 'Acme' }, { id: 'zeta', name: 'Zeta' }],
      [{ tenant_id: 'default', month: '2026-11', posts: 30 }, { tenant_id: 'acme', month: '2026-11', posts: 10 }, { tenant_id: 'zeta', month: '2026-11', posts: 50 }, { tenant_id: 'acme', month: '2026-10', posts: 7 }],
      new Date('2026-11-10T06:00:00Z'),
      ['zeta'],
    );
    expect(html).toContain('40 of 1000 successful posts used in 11-2026');
    expect(html).toContain('10-2026');
    expect(html).toContain('$2.50'); // acme: 10 of 40
    expect(html).toContain('own Post for Me key');
    expect(html).not.toContain('—');
  });
});
