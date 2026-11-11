import { describe, it, expect } from 'vitest';
import { createFirstCommentSenders, facebookTargets } from '../src/services/firstCommentSenders.js';
import { normalizeResearch, normalizeRefill, researchPrompt, refillPrompt } from '../src/utils/routerSpec.js';

const DASH = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

describe('Facebook first comment targets', () => {
  it('a bare post id becomes page_post, then the video id from the URL', () => {
    expect(facebookTargets('2483716778786473', { url: 'https://facebook.com/1151908658010770/videos/2483716778786473' }))
      .toEqual(['1151908658010770_2483716778786473', '2483716778786473']);
    expect(facebookTargets('99', { url: 'https://facebook.com/11/videos/22', pageId: '11' })).toEqual(['11_99', '22', '99']);
    expect(facebookTargets('1_2')).toEqual(['1_2']);
    expect(facebookTargets('5')).toEqual(['5']);
  });

  it('a "(#12) singular statuses" refusal moves on to the next id', async () => {
    const calls = [];
    const refuse = { ok: false, status: 400, data: { error: { message: '(#12) singular statuses API is deprecated for versions v2.4 and higher' } } };
    const replies = [refuse, { ok: true, status: 200, data: { id: 'c1' } }];
    const req = async (url) => { calls.push(url); return replies[Math.min(calls.length - 1, 1)]; };
    const out = await createFirstCommentSenders({ request: req }).comment({
      platform: 'facebook', postId: '777', token: 't', text: 'hi',
      account: { user_id: '11' }, url: 'https://facebook.com/11/videos/888',
    });
    expect(out.state).toBe('ok');
    expect(calls).toEqual(['https://graph.facebook.com/v21.0/11_777/comments', 'https://graph.facebook.com/v21.0/888/comments']);
  });

  it('a token refusal stops at once, no second comment attempt', async () => {
    const calls = [];
    const req = async (url) => { calls.push(url); return { ok: false, status: 401, data: { error: { message: 'Error validating access token' } } }; };
    await expect(createFirstCommentSenders({ request: req }).comment({ platform: 'facebook', postId: '777', token: 't', text: 'hi', url: 'https://facebook.com/11/videos/888' })).rejects.toThrow('access token');
    expect(calls).toHaveLength(1);
  });
});

describe('AI text never carries em or en dashes', () => {
  it('research reply', () => {
    const r = normalizeResearch({ topic: `City ${DASH} Culture`, angle: 'a', title: `City ${DASH} Culture ${EN} now`, caption: `Hook ${DASH} body`, headline: `Start ${DASH} With You`, subhead: 'x' });
    for (const v of Object.values(r)) expect(String(v)).not.toMatch(/[–—]/);
    expect(r.headline).toBe('Start, With You');
  });
  it('sheet refill rows', () => {
    const rows = normalizeRefill({ posts: [{ imagePrompt: 'p', headline: `A ${DASH} B`, subhead: `c${EN}d`, caption: `x ${DASH} y`, captionShort: `s ${DASH} t` }] });
    expect(JSON.stringify(rows)).not.toMatch(/[–—]/);
  });
  it('both prompts say so', () => {
    expect(researchPrompt({}).system).toContain('Never use em dashes');
    expect(refillPrompt({}).system).toContain('Never use em dashes');
  });
});
