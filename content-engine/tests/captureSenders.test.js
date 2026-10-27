import { describe, it, expect } from 'vitest';
import { createCaptureSenders, isRetryableStatus } from '../src/services/captureSenders.js';

function recorder(response) {
  const calls = [];
  const req = async (url, opts) => { calls.push({ url, opts }); return response; };
  return { calls, req };
}
const ok = { ok: true, status: 200, data: { id: 'x' } };

describe('captureSenders.sendDm', () => {
  it('POSTs to /{accountId}/messages with recipient.comment_id and the token in the header, not the URL', async () => {
    const { calls, req } = recorder(ok);
    const s = createCaptureSenders({ request: req });
    await s.sendDm({ accountId: 'acct1', pageToken: 'SECRET', recipientCommentId: 'c1', text: 'Here', link: 'https://x.co/a' });
    const { url, opts } = calls[0];
    expect(url).toContain('/acct1/messages');
    expect(url).not.toContain('SECRET'); // token never in the URL
    expect(opts.headers.Authorization).toBe('Bearer SECRET');
    expect(opts.method).toBe('POST');
    expect(opts.body).toEqual({ recipient: { comment_id: 'c1' }, message: { text: 'Here\nhttps://x.co/a' } });
  });
  it('does not duplicate a link already present in the text', async () => {
    const { calls, req } = recorder(ok);
    const s = createCaptureSenders({ request: req });
    await s.sendDm({ accountId: 'a', pageToken: 't', recipientCommentId: 'c', text: 'Here https://x.co/a', link: 'https://x.co/a' });
    expect(calls[0].opts.body.message.text).toBe('Here https://x.co/a');
  });
});

describe('captureSenders.sendPublicReply', () => {
  it('uses the replies edge for Instagram and comments edge for Facebook', async () => {
    const ig = recorder(ok); await createCaptureSenders({ request: ig.req }).sendPublicReply({ platform: 'instagram', pageToken: 't', commentId: 'c1', message: 'hi' });
    expect(ig.calls[0].url).toContain('/c1/replies');
    const fb = recorder(ok); await createCaptureSenders({ request: fb.req }).sendPublicReply({ platform: 'facebook', pageToken: 't', commentId: 'c2', message: 'hi' });
    expect(fb.calls[0].url).toContain('/c2/comments');
  });
});

describe('captureSenders.deleteComment', () => {
  it('DELETEs /{commentId}', async () => {
    const { calls, req } = recorder(ok);
    await createCaptureSenders({ request: req }).deleteComment({ pageToken: 't', commentId: 'c9' });
    expect(calls[0].opts.method).toBe('DELETE');
    expect(calls[0].url).toMatch(/\/c9$/);
  });
});

describe('error classification (retry policy)', () => {
  it('4xx (window closed) is not retryable; 5xx and 429 are', async () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });
  it('a 4xx throws a non-retryable error; a 5xx throws retryable', async () => {
    const s4 = createCaptureSenders({ request: async () => ({ ok: false, status: 400, data: { error: { code: 10, message: 'outside 7 day window' } } }) });
    await expect(s4.sendDm({ accountId: 'a', pageToken: 't', recipientCommentId: 'c', text: 'x' }))
      .rejects.toMatchObject({ retryable: false, status: 400 });

    const s5 = createCaptureSenders({ request: async () => ({ ok: false, status: 503, text: 'upstream' }) });
    await expect(s5.sendDm({ accountId: 'a', pageToken: 't', recipientCommentId: 'c', text: 'x' }))
      .rejects.toMatchObject({ retryable: true, status: 503 });
  });
});
