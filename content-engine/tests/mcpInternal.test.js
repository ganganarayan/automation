/**
 * Internal MCP endpoint: the service secret, the email-to-account mapping
 * ("no_account"), the tool catalogue's annotations, and the confirm gate on
 * schedule_post, edit_post and cancel_post.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

const publish = {
  listAccounts: vi.fn(async () => ({ data: [{ id: 'acc_ig', platform: 'instagram', username: 'brand' }, { id: 'acc_fb', platform: 'facebook', username: 'Brand' }] })),
  createPost: vi.fn(async () => ({ id: 'sp_1' })),
  updatePost: vi.fn(async () => ({ id: 'sp_1' })),
  getPost: vi.fn(async () => ({ id: 'sp_1', status: 'scheduled' })),
  authUrl: vi.fn(async () => ({ url: 'https://connect.example/x' })),
};
const repo = {
  get: vi.fn(),
  list: vi.fn(async () => []),
  saveSteps: vi.fn(async () => {}),
  markScheduled: vi.fn(async () => true),
};
const unscheduleInstance = vi.fn(async ({ instanceId }) => ({ instanceId }));

vi.mock('../src/settings/index.js', () => { const s = { tz: 'Asia/Kolkata', auth: { gatewaySecret: '' } }; return { settings: s, default: s }; });
vi.mock('../src/repositories/usersRepository.js', () => ({ findByEmail: vi.fn(async () => null) }));
vi.mock('../src/core/logger.js', () => {
  const l = { info() {}, warn() {}, error() {}, debug() {} };
  l.child = () => l;
  return { childLogger: () => l, logger: l, default: l };
});
vi.mock('../src/services/providerFactory.js', () => ({ buildProviders: vi.fn(async () => ({ publish, resolved: { postformeKey: 'k' } })) }));
vi.mock('../src/services/planService.js', () => ({
  tenantInfo: vi.fn(async () => ({ live: true, plan: 'brand', expiresAt: null })),
  limitReason: vi.fn(async () => ''),
}));
vi.mock('../src/repositories/instanceRepository.js', () => repo);
vi.mock('../src/services/instanceService.js', () => ({
  createForFunnel: vi.fn(async () => ({ id: 'inst-new' })),
  parseSteps: (row) => (Array.isArray(row.steps) ? row.steps : []),
}));
vi.mock('../src/services/readyPostService.js', () => ({ unscheduleInstance, generateThumbnail: vi.fn() }));
vi.mock('../src/services/imageLaneService.js', () => ({ prepare: vi.fn() }));
vi.mock('../src/services/aiLaneService.js', () => ({ prepare: vi.fn() }));
vi.mock('../src/repositories/funnelsRepository.js', () => ({ get: vi.fn(), listByTenant: vi.fn(async () => []), resolve: vi.fn() }));
vi.mock('../src/repositories/jobRepository.js', () => ({ getForTenant: vi.fn(), setResult: vi.fn() }));
vi.mock('../src/core/jobRunner.js', () => ({ registerHandler: vi.fn(), enqueueJob: vi.fn(async () => ({ id: 7 })) }));
vi.mock('../src/modules/connectPage.js', () => ({
  CONNECT_PLATFORMS: [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['youtube', 'YouTube']],
}));

const { mount, TOOLS } = await import('../src/modules/mcpInternal.js');
const tools = await import('../src/services/mcpToolsService.js');

const SECRET = 'test-secret-123';
const users = { 'owner@example.com': { email: 'owner@example.com', tenant_id: 't1', tenant_role: 'admin' } };
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mount(app, { getSecret: () => SECRET, findByEmail: async (e) => users[e] || null });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/mcp-internal`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => vi.clearAllMocks());

const rpc = (method, params = {}, headers = {}) => fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
});
const ok = { 'x-service-secret': SECRET, 'x-user-email': 'owner@example.com' };

describe('auth', () => {
  it('rejects a call with no service secret', async () => {
    const res = await rpc('tools/list', {}, { 'x-user-email': 'owner@example.com' });
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe('unauthorized');
  });

  it('rejects a wrong service secret', async () => {
    const res = await rpc('tools/list', {}, { 'x-service-secret': 'nope', 'x-user-email': 'owner@example.com' });
    expect(res.status).toBe(401);
  });

  it('refuses everything when no secret is configured', async () => {
    const app = express();
    app.use(express.json());
    mount(app, { getSecret: () => '', findByEmail: async (e) => users[e] || null });
    const s = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
    const res = await fetch(`http://127.0.0.1:${s.address().port}/mcp-internal`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-service-secret': '', 'x-user-email': 'owner@example.com' }, body: '{}',
    });
    await new Promise((r) => s.close(r));
    expect(res.status).toBe(401);
  });

  it('GET is not allowed (stateless endpoint)', async () => {
    const res = await fetch(base, { headers: ok });
    expect(res.status).toBe(405);
  });
});

describe('no_account', () => {
  it('returns no_account for an email with no account', async () => {
    const res = await rpc('tools/list', {}, { 'x-service-secret': SECRET, 'x-user-email': 'stranger@example.com' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toBe('no_account');
    expect(body.error.data.error).toBe('no_account');
  });

  it('returns no_account when the email header is missing', async () => {
    const res = await rpc('tools/list', {}, { 'x-service-secret': SECRET });
    expect((await res.json()).error.message).toBe('no_account');
  });
});

describe('tool catalogue', () => {
  it('lists every tool with a description and a read-only or destructive hint', async () => {
    const res = await rpc('tools/list', {}, ok);
    expect(res.status).toBe(200);
    const { result } = await res.json();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(TOOLS.map((t) => t[0]).sort());
    expect(names).toHaveLength(12);
    for (const t of result.tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
      expect(typeof t.annotations.destructiveHint).toBe('boolean');
    }
    const by = Object.fromEntries(result.tools.map((t) => [t.name, t.annotations]));
    expect(by.get_entitlement.readOnlyHint).toBe(true);
    expect(by.cancel_post.destructiveHint).toBe(true);
    expect(by.edit_post.destructiveHint).toBe(true);
  });

  it('calls a tool in the caller\'s workspace and returns compact JSON', async () => {
    const res = await rpc('tools/call', { name: 'get_entitlement', arguments: {} }, ok);
    const { result } = await res.json();
    expect(JSON.parse(result.content[0].text)).toEqual({ active: true, plan: 'brand', expires_ist: null });
  });
});

const ctx = { tenantId: 't1', email: 'owner@example.com' };
const scheduledRow = (over = {}) => ({
  id: 'inst-1', tenant_id: 't1', status: 'scheduled', locked: false, title: 'Hello', scheduled_for: '2030-01-01T10:00:00Z',
  post_refs: ['sp_1'],
  steps: [{ key: 'publish', artifacts: { posts: ['sp_1'], caption: 'old', channels: [{ id: 'acc_ig', platform: 'instagram', name: 'brand' }], request: { caption: 'old', mediaUrl: 'https://cdn.example/v.mp4' } } }],
  ...over,
});

describe('confirm gate', () => {
  const args = { media_url: 'https://cdn.example/a.jpg', caption: 'Hi', platforms: ['instagram'], time: '2030-01-01T10:00:00+05:30' };

  it('schedule_post without confirm only previews', async () => {
    const out = await tools.schedulePost(ctx, args);
    expect(out.preview).toBe(true);
    expect(out.will_schedule.channels).toEqual([{ platform: 'instagram', name: 'brand' }]);
    expect(publish.createPost).not.toHaveBeenCalled();
    expect(repo.markScheduled).not.toHaveBeenCalled();
  });

  it('schedule_post with confirm=false is still a preview', async () => {
    const out = await tools.schedulePost(ctx, { ...args, confirm: false });
    expect(out.preview).toBe(true);
    expect(publish.createPost).not.toHaveBeenCalled();
  });

  it('schedule_post with confirm=true posts through the pipeline', async () => {
    const out = await tools.schedulePost(ctx, { ...args, confirm: true });
    expect(out.scheduled).toBe(true);
    expect(publish.createPost).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ['acc_ig'], caption: 'Hi', mediaUrl: args.media_url }));
    expect(repo.markScheduled).toHaveBeenCalledWith('inst-new', expect.objectContaining({ postRefs: ['sp_1'] }));
  });

  it('schedule_post refuses a platform that is not connected', async () => {
    await expect(tools.schedulePost(ctx, { ...args, platforms: ['youtube'], confirm: true })).rejects.toMatchObject({ code: 'not_connected' });
    expect(publish.createPost).not.toHaveBeenCalled();
  });

  it('a sheet-row schedule only queues its job with confirm=true', async () => {
    const funnels = await import('../src/repositories/funnelsRepository.js');
    const jobRunner = await import('../src/core/jobRunner.js');
    funnels.get.mockResolvedValue({ id: 'f1', tenant_id: 't1', name: 'Main' });
    const preview = await tools.schedulePost(ctx, { sheet_row: { funnel_id: 'f1' }, time: '2030-01-01T10:00:00+05:30' });
    expect(preview.preview).toBe(true);
    expect(jobRunner.enqueueJob).not.toHaveBeenCalled();
    const done = await tools.schedulePost(ctx, { sheet_row: { funnel_id: 'f1' }, time: '2030-01-01T10:00:00+05:30', confirm: true });
    expect(done.job_id).toBe('7');
    expect(jobRunner.enqueueJob).toHaveBeenCalledOnce();
  });

  it('edit_post without confirm previews, with confirm updates Post for Me', async () => {
    repo.get.mockResolvedValue(scheduledRow());
    const preview = await tools.editPost(ctx, { post_id: 'inst-1', caption: 'new' });
    expect(preview).toMatchObject({ preview: true, will_change: { caption_from: 'old', caption_to: 'new' } });
    expect(publish.updatePost).not.toHaveBeenCalled();
    const done = await tools.editPost(ctx, { post_id: 'inst-1', caption: 'new', confirm: true });
    expect(done.edited).toBe(true);
    expect(publish.updatePost).toHaveBeenCalledWith('sp_1', expect.objectContaining({ caption: 'new', accountIds: ['acc_ig'] }));
  });

  it('cancel_post without confirm previews, with confirm unschedules', async () => {
    repo.get.mockResolvedValue(scheduledRow());
    const preview = await tools.cancelPost(ctx, { post_id: 'inst-1' });
    expect(preview.preview).toBe(true);
    expect(unscheduleInstance).not.toHaveBeenCalled();
    const done = await tools.cancelPost(ctx, { post_id: 'inst-1', confirm: true });
    expect(done).toEqual({ cancelled: true, post_id: 'inst-1' });
    expect(unscheduleInstance).toHaveBeenCalledWith({ instanceId: 'inst-1' });
  });

  it('never touches another workspace\'s post', async () => {
    repo.get.mockResolvedValue(scheduledRow({ tenant_id: 'other' }));
    await expect(tools.cancelPost(ctx, { post_id: 'inst-1', confirm: true })).rejects.toMatchObject({ code: 'not_found' });
    expect(unscheduleInstance).not.toHaveBeenCalled();
  });

  it('the confirm gate holds over HTTP too', async () => {
    const res = await rpc('tools/call', { name: 'schedule_post', arguments: args }, ok);
    const { result } = await res.json();
    expect(JSON.parse(result.content[0].text).preview).toBe(true);
    expect(publish.createPost).not.toHaveBeenCalled();
  });
});

describe('compactMetrics', () => {
  it('maps each platform to reach, views, likes, comments, shares', () => {
    expect(tools.compactMetrics('instagram', { reach: 10, views: 20, likes: 3, comments: 1, shares: 2 })).toEqual({ reach: 10, views: 20, likes: 3, comments: 1, shares: 2 });
    expect(tools.compactMetrics('x', { public_metrics: { impression_count: 9, like_count: 4, reply_count: 1, retweet_count: 2 } })).toMatchObject({ reach: 9, likes: 4, comments: 1, shares: 2, views: null });
    expect(tools.compactMetrics('youtube', null)).toBeNull();
  });
});
