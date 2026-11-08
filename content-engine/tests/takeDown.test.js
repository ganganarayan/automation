import { describe, it, expect } from 'vitest';
import { createTakeDownSenders, takeDownPlatform } from '../src/services/takeDownSenders.js';
import { channelIcon, channelText } from '../src/utils/laneSpec.js';
import { postedLinks } from '../src/utils/routerSpec.js';

function recorder(responses) {
  const calls = [];
  const list = Array.isArray(responses) ? responses : [responses];
  const req = async (url, opts) => { calls.push({ url, opts }); return list[Math.min(calls.length - 1, list.length - 1)]; };
  return { calls, req };
}
const ok = { ok: true, status: 200, data: { success: true } };

describe('takeDownSenders', () => {
  it('Facebook: DELETE on the post, token in the header only', async () => {
    const { calls, req } = recorder(ok);
    const out = await createTakeDownSenders({ request: req }).takeDown({ platform: 'facebook', postId: '1_2', tokens: [{ via: 'meta', token: 'SECRET' }] });
    expect(out).toMatchObject({ state: 'ok', via: 'meta' });
    expect(calls[0].opts.method).toBe('DELETE');
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/1_2');
    expect(calls[0].url).not.toContain('SECRET');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer SECRET');
  });

  it('each platform hits its own delete URL', async () => {
    const cases = [
      ['threads', 't1', 'https://graph.threads.net/v1.0/t1'],
      ['youtube', 'v1', 'https://www.googleapis.com/youtube/v3/videos?id=v1'],
      ['twitter', '99', 'https://api.x.com/2/tweets/99'],
      ['pinterest', 'p1', 'https://api.pinterest.com/v5/pins/p1'],
      ['linkedin', 'urn:li:share:9', 'https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A9'],
    ];
    for (const [platform, postId, url] of cases) {
      const { calls, req } = recorder(ok);
      await createTakeDownSenders({ request: req }).takeDown({ platform, postId, tokens: [{ via: 'postforme', token: 't' }] });
      expect(calls[0].url).toBe(url);
    }
  });

  it('a 404 counts as already gone', async () => {
    const { req } = recorder({ ok: false, status: 404, data: {} });
    const out = await createTakeDownSenders({ request: req }).takeDown({ platform: 'x', postId: '1', tokens: [{ via: 'postforme', token: 't' }] });
    expect(out).toMatchObject({ state: 'ok', gone: true });
  });

  it('falls back to the next token, then throws with every try listed', async () => {
    const { calls, req } = recorder({ ok: false, status: 403, data: { error: { message: 'no permission' } } });
    await expect(createTakeDownSenders({ request: req }).takeDown({
      platform: 'instagram', postId: 'm1', tokens: [{ via: 'meta', token: 'a' }, { via: 'postforme', token: 'IGb' }],
    })).rejects.toThrow(/meta: 403: no permission \| postforme: 403: no permission/);
    expect(calls[1].url).toBe('https://graph.instagram.com/v21.0/m1');
  });

  it('TikTok, a missing post id or token: skipped, nothing called', async () => {
    const { calls, req } = recorder(ok);
    const s = createTakeDownSenders({ request: req });
    expect((await s.takeDown({ platform: 'tiktok', postId: '1', tokens: [{ via: 'p', token: 't' }] })).state).toBe('skipped');
    expect((await s.takeDown({ platform: 'x', postId: '', tokens: [{ via: 'p', token: 't' }] })).state).toBe('skipped');
    expect((await s.takeDown({ platform: 'x', postId: '1', tokens: [] })).state).toBe('skipped');
    expect(calls.length).toBe(0);
    expect(takeDownPlatform('Pinterest')).toBe('pinterest');
  });
});

describe('taken down channels', () => {
  const c = { state: 'ok', platform: 'youtube', name: 'Ganga', url: 'https://y/1', removedAt: '2026-11-08T10:00:00Z' };
  it('show 🗑 and drop out of the live links', () => {
    expect(channelIcon(c)).toBe('🗑');
    expect(channelText(c)).toContain('(taken down)');
    expect(postedLinks([c, { state: 'ok', url: 'https://x/2' }])).toEqual(['https://x/2']);
  });
});
