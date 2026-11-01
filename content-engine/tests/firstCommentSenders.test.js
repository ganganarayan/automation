import { describe, it, expect } from 'vitest';
import { createFirstCommentSenders, commentPlatform, linkedinUrn, linkedinActors } from '../src/services/firstCommentSenders.js';

function recorder(responses) {
  const calls = [];
  const list = Array.isArray(responses) ? responses : [responses];
  const req = async (url, opts) => { calls.push({ url, opts }); return list[Math.min(calls.length - 1, list.length - 1)]; };
  return { calls, req };
}
const ok = { ok: true, status: 200, data: { id: 'c1' } };
const link = 'https://example.com/offer';

describe('firstCommentSenders', () => {
  it('Facebook: comments on the post with the token in the header, not the URL', async () => {
    const { calls, req } = recorder(ok);
    const out = await createFirstCommentSenders({ request: req }).comment({ platform: 'facebook', postId: '1_2', token: 'SECRET', text: link });
    expect(out.state).toBe('ok');
    expect(calls[0].url).toBe('https://graph.facebook.com/v21.0/1_2/comments');
    expect(calls[0].url).not.toContain('SECRET');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer SECRET');
    expect(calls[0].opts.body).toEqual({ message: link });
  });

  it('Instagram: an Instagram Login token goes to graph.instagram.com', async () => {
    const { calls, req } = recorder(ok);
    await createFirstCommentSenders({ request: req }).comment({ platform: 'instagram', postId: 'm1', token: 'IGQ123', text: link });
    expect(calls[0].url).toBe('https://graph.instagram.com/v21.0/m1/comments');
  });

  it('Threads: creates a reply container, then publishes it', async () => {
    const { calls, req } = recorder([{ ok: true, status: 200, data: { id: 'ct1' } }, ok]);
    await createFirstCommentSenders({ request: req }).comment({ platform: 'threads', postId: 't1', token: 't', text: link });
    expect(calls[0].url).toContain('reply_to_id=t1');
    expect(calls[1].url).toContain('threads_publish?creation_id=ct1');
  });

  it('LinkedIn: tries the organization actor, then the person', async () => {
    const { calls, req } = recorder([{ ok: false, status: 403, data: { message: 'no' } }, ok]);
    const out = await createFirstCommentSenders({ request: req }).comment({ platform: 'linkedin', postId: 'urn:li:share:9', token: 't', text: link, account: { user_id: 'abc' } });
    expect(out.state).toBe('ok');
    expect(calls[0].url).toContain(encodeURIComponent('urn:li:share:9'));
    expect(calls[0].opts.body.actor).toBe('urn:li:organization:abc');
    expect(calls[1].opts.body.actor).toBe('urn:li:person:abc');
  });

  it('YouTube and X: top-level comment / reply tweet', async () => {
    const { calls, req } = recorder(ok);
    const s = createFirstCommentSenders({ request: req });
    await s.comment({ platform: 'youtube', postId: 'v1', token: 't', text: link });
    await s.comment({ platform: 'twitter', postId: 'tw1', token: 't', text: link });
    expect(calls[0].opts.body.snippet.videoId).toBe('v1');
    expect(calls[1].opts.body).toEqual({ text: link, reply: { in_reply_to_tweet_id: 'tw1' } });
  });

  it('skips platforms without a comment API, and a missing token or id', async () => {
    const { calls, req } = recorder(ok);
    const s = createFirstCommentSenders({ request: req });
    expect((await s.comment({ platform: 'tiktok', postId: '1', token: 't', text: link })).state).toBe('skipped');
    expect((await s.comment({ platform: 'facebook', postId: '', token: 't', text: link })).state).toBe('skipped');
    expect((await s.comment({ platform: 'facebook', postId: '1', token: '', text: link })).state).toBe('skipped');
    expect(calls.length).toBe(0);
  });

  it('marks 5xx / 429 retryable and 4xx not', async () => {
    const s5 = createFirstCommentSenders({ request: recorder({ ok: false, status: 503, data: {} }).req });
    await expect(s5.comment({ platform: 'facebook', postId: '1', token: 't', text: link })).rejects.toMatchObject({ retryable: true });
    const s4 = createFirstCommentSenders({ request: recorder({ ok: false, status: 400, data: { error: { message: 'bad' } } }).req });
    await expect(s4.comment({ platform: 'facebook', postId: '1', token: 't', text: link })).rejects.toMatchObject({ retryable: false });
  });

  it('fallback: a failed first token falls through to the next', async () => {
    const { calls, req } = recorder([{ ok: false, status: 400, data: { error: { message: 'no perm' } } }, ok]);
    const out = await createFirstCommentSenders({ request: req }).commentWithFallback({
      platform: 'instagram', postId: 'm1', text: link, tokens: [{ via: 'meta', token: 'META' }, { via: 'postforme', token: 'PFM' }],
    });
    expect(out).toMatchObject({ state: 'ok', via: 'postforme' });
    expect(out.tried[0]).toContain('meta');
    expect(calls.map((c) => c.opts.headers.Authorization)).toEqual(['Bearer META', 'Bearer PFM']);
  });

  it('fallback: the first token that works is the only one used', async () => {
    const { calls, req } = recorder(ok);
    const out = await createFirstCommentSenders({ request: req }).commentWithFallback({
      platform: 'facebook', postId: '1_2', text: link, tokens: [{ via: 'meta', token: 'META' }, { via: 'postforme', token: 'PFM' }],
    });
    expect(out.via).toBe('meta');
    expect(calls.length).toBe(1);
  });

  it('fallback: every token failing throws both errors; no tokens is skipped', async () => {
    const s = createFirstCommentSenders({ request: recorder({ ok: false, status: 400, data: { error: { message: 'bad' } } }).req });
    await expect(s.commentWithFallback({ platform: 'facebook', postId: '1', text: link, tokens: [{ via: 'meta', token: 'a' }, { via: 'postforme', token: 'b' }] }))
      .rejects.toThrow(/meta: .*\| postforme: /);
    expect((await s.commentWithFallback({ platform: 'facebook', postId: '1', text: link, tokens: [] })).state).toBe('skipped');
  });

  it('helpers', () => {
    expect(commentPlatform('X')).toBe('x');
    expect(commentPlatform('pinterest')).toBe('');
    expect(linkedinUrn('123')).toBe('urn:li:ugcPost:123');
    expect(linkedinActors('urn:li:person:1')).toEqual(['urn:li:person:1']);
  });
});
