import { describe, it, expect, vi, beforeEach } from 'vitest';

let session = null;
let machine = false;
const owners = {};
vi.mock('../src/services/accessService.js', () => ({
  currentSession: async () => session,
  adminKeyOk: () => machine,
}));
vi.mock('../src/repositories/ownershipRepository.js', () => ({
  validId: (kind, id) => (kind === 'instance' ? /^[0-9a-f-]{36}$/.test(String(id)) : /^\d+$/.test(String(id))),
  tenantOf: async (kind, id) => owners[`${kind}:${id}`] || null,
}));

const { decide, recordDecision, namedRecords, paramKind, bindTenant, guardRecords, guardParamId } = await import('../src/middleware/tenantGuard.js');

const INST = '11111111-2222-3333-4444-555555555555';

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.type = () => res;
  res.send = (b) => { res.body = b; return res; };
  return res;
}
function fakeReq(over = {}) {
  return { tenantId: 'default', tenantAsked: '', query: {}, body: {}, path: '/admin/x', method: 'POST', accepts: () => 'json', ...over };
}
async function run(mw, req, ...extra) {
  const res = fakeRes();
  let passed = false;
  await mw(req, res, () => { passed = true; }, ...extra);
  return { res, passed, req };
}

beforeEach(() => {
  session = null;
  machine = false;
  for (const k of Object.keys(owners)) delete owners[k];
  owners['funnel:7'] = 'acme';
  owners['funnel:8'] = 'zeta';
  owners[`instance:${INST}`] = 'zeta';
  owners['rule:3'] = 'zeta';
  owners['lead:4'] = 'acme';
});

describe('decide: which tenant a request works in', () => {
  it('a signed-in tenant user always works in its own tenant', () => {
    expect(decide({ session: { role: 'admin', tenantId: 'acme' }, resolved: 'default' })).toEqual({ tenantId: 'acme', superAdmin: false });
  });
  it('asking for another tenant by header, path, query or body is refused', () => {
    expect(decide({ session: { role: 'admin', tenantId: 'acme' }, asked: ['zeta'] })).toEqual({ refuse: true });
    expect(decide({ session: { role: 'admin', tenantId: 'acme' }, asked: ['', 'acme'] })).toEqual({ tenantId: 'acme', superAdmin: false });
  });
  it('the super admin may open any tenant', () => {
    expect(decide({ session: { role: 'super_admin', tenantId: 'default' }, resolved: 'zeta', asked: ['zeta'] })).toEqual({ tenantId: 'zeta', superAdmin: true });
  });
  it('a super admin who must still change the password is not the operator', () => {
    expect(decide({ session: { role: 'super_admin', tenantId: 'default', mustChange: true }, asked: ['zeta'] })).toEqual({ refuse: true });
  });
  it('no session (webhook, public page, machine key) keeps what it resolved to', () => {
    expect(decide({ session: null, resolved: 'zeta', asked: ['zeta'] })).toEqual({ tenantId: 'zeta', superAdmin: false });
  });
});

describe('recordDecision', () => {
  it('own record ok, another tenant\'s denied, operator switched, missing left to the route', () => {
    expect(recordDecision({ recordTenant: 'acme', tenantId: 'acme', operator: false })).toBe('ok');
    expect(recordDecision({ recordTenant: 'zeta', tenantId: 'acme', operator: false })).toBe('deny');
    expect(recordDecision({ recordTenant: 'zeta', tenantId: 'default', operator: true })).toBe('switch');
    expect(recordDecision({ recordTenant: null, tenantId: 'acme', operator: false })).toBe('ok');
  });
  it('finds the ids a request names, and the kind of an :id path', () => {
    expect(namedRecords({ query: { funnel: '7' }, body: { funnelId: 8, instance_id: INST, other: 1, funnel_id: { x: 1 } } }))
      .toEqual([['funnel', '7'], ['funnel', '8'], ['instance', INST]]);
    expect(paramKind('/admin/instances/abc/approve')).toBe('instance');
    expect(paramKind('/admin/funnels/7/setup')).toBe('funnel');
    expect(paramKind('/admin/capture/leads/4/delete')).toBe('lead');
    expect(paramKind('/admin/festival/9/approve')).toBe(null);
  });
});

describe('bindTenant middleware', () => {
  it('sets the session tenant over a header-resolved one, and rewrites ?tenant=', async () => {
    session = { role: 'admin', tenantId: 'acme' };
    const { passed, req } = await run(bindTenant, fakeReq({ tenantId: 'default', query: { tenant: 'acme' } }));
    expect(passed).toBe(true);
    expect(req.tenantId).toBe('acme');
    expect(req.query.tenant).toBe('acme');
  });
  it('403 when a tenant admin sends X-Tenant for another tenant', async () => {
    session = { role: 'admin', tenantId: 'acme' };
    const { passed, res } = await run(bindTenant, fakeReq({ tenantId: 'zeta', tenantAsked: 'zeta' }));
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(403);
  });
  it('403 on body.tenant for another tenant', async () => {
    session = { role: 'admin', tenantId: 'acme' };
    const { res } = await run(bindTenant, fakeReq({ body: { tenant: 'zeta' } }));
    expect(res.statusCode).toBe(403);
  });
  it('the machine admin key is the operator', async () => {
    machine = true;
    const { req } = await run(bindTenant, fakeReq({ tenantId: 'zeta', tenantAsked: 'zeta' }));
    expect(req.tenantId).toBe('zeta');
    expect(req.tenantOperator).toBe(true);
  });
});

describe('record guards', () => {
  it('404 on another tenant\'s funnel in the body', async () => {
    const { passed, res } = await run(guardRecords, fakeReq({ path: '/admin/instances/ready/post', tenantId: 'acme', body: { funnelId: 8 } }));
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(404);
  });
  it('404 on another tenant\'s funnel in the query', async () => {
    const { res } = await run(guardRecords, fakeReq({ path: '/admin/instances/prepare', method: 'GET', tenantId: 'acme', query: { funnel: '8' } }));
    expect(res.statusCode).toBe(404);
  });
  it('own funnel passes; a non-admin path is not checked', async () => {
    expect((await run(guardRecords, fakeReq({ tenantId: 'acme', body: { funnel_id: '7' } }))).passed).toBe(true);
    expect((await run(guardRecords, fakeReq({ path: '/webhook/x', tenantId: 'acme', body: { funnelId: 8 } }))).passed).toBe(true);
  });
  it('the super admin is switched to the record\'s tenant', async () => {
    const { passed, req } = await run(guardRecords, fakeReq({ tenantId: 'default', tenantOperator: true, body: { funnelId: 8 } }));
    expect(passed).toBe(true);
    expect(req.tenantId).toBe('zeta');
  });
  it('404 on another tenant\'s instance, rule or lead in the path', async () => {
    for (const [path, id] of [[`/admin/instances/${INST}/approve`, INST], ['/admin/capture/rules/3/toggle', '3'], ['/admin/funnels/8/setup', '8']]) {
      const { passed, res } = await run(guardParamId, fakeReq({ path, tenantId: 'acme' }), id);
      expect(passed, path).toBe(false);
      expect(res.statusCode, path).toBe(404);
    }
    expect((await run(guardParamId, fakeReq({ path: '/admin/capture/leads/4/delete', tenantId: 'acme' }), '4')).passed).toBe(true);
  });
  it('an unknown id is left to the route (its own not found)', async () => {
    expect((await run(guardParamId, fakeReq({ path: '/admin/funnels/99/setup', tenantId: 'acme' }), '99')).passed).toBe(true);
  });
});
