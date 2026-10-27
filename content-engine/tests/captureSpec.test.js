import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  normalize,
  matchKeyword,
  firstMatchingRule,
  ageSeconds,
  isOlderThan7Days,
  detectAbuse,
  pickVariant,
  verifyMetaSignature,
  parseCommentEvents,
} from '../src/utils/captureSpec.js';

describe('normalize', () => {
  it('lowercases, drops punctuation + emoji, keeps Hindi letters', () => {
    expect(normalize('WANT!! 😍 the Link?')).toBe('want the link');
    expect(normalize('मुझे चाहिए 🙏')).toBe('मुझे चाहिए');
  });
});

describe('matchKeyword', () => {
  it('word mode: whole word, case/punctuation/emoji insensitive', () => {
    expect(matchKeyword('I really WANT 😍 this!', 'want', 'word')).toBe(true);
    expect(matchKeyword('I want-it', 'want', 'word')).toBe(true);
    expect(matchKeyword('wanted it', 'want', 'word')).toBe(false); // not a whole word
  });
  it('contains mode: substring', () => {
    expect(matchKeyword('wanted', 'want', 'contains')).toBe(true);
  });
  it('matches a multi-word phrase in word mode', () => {
    expect(matchKeyword('please send me the guide now', 'the guide', 'word')).toBe(true);
  });
});

describe('firstMatchingRule', () => {
  const rules = [
    { id: 1, keyword: 'price', match_mode: 'word', active: true },
    { id: 2, keyword: 'guide', match_mode: 'word', active: true },
    { id: 3, keyword: 'guide', match_mode: 'word', active: false },
  ];
  it('returns the first active rule that matches', () => {
    expect(firstMatchingRule('send the guide', rules).id).toBe(2);
    expect(firstMatchingRule('nothing here', rules)).toBeNull();
  });
});

describe('age / 7-day window', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  it('older than 7 days (counted from creation) is true', () => {
    expect(isOlderThan7Days(new Date('2026-10-17T11:00:00Z'), now)).toBe(true); // 8 days
  });
  it('within 7 days is false', () => {
    expect(isOlderThan7Days(new Date('2026-10-20T12:00:00Z'), now)).toBe(false); // 5 days
  });
  it('unknown creation time is treated as fresh', () => {
    expect(isOlderThan7Days(null, now)).toBe(false);
  });
  it('accepts unix seconds', () => {
    const eightDaysAgo = Math.floor(now.getTime() / 1000) - 8 * 86400;
    expect(Math.round(ageSeconds(eightDaysAgo, now))).toBe(8 * 86400);
    expect(isOlderThan7Days(eightDaysAgo, now)).toBe(true);
  });
});

describe('detectAbuse', () => {
  it('flags Hindi (Devanagari), Hinglish, and English abuse', () => {
    expect(detectAbuse('tu to chutiya hai').abusive).toBe(true);
    expect(detectAbuse('madarchod').abusive).toBe(true);
    expect(detectAbuse('यह चूतिया है').abusive).toBe(true);
    expect(detectAbuse('you are an asshole').abusive).toBe(true);
  });
  it('passes clean comments', () => {
    expect(detectAbuse('please send me the price').abusive).toBe(false);
    expect(detectAbuse('मुझे गाइड चाहिए').abusive).toBe(false);
  });
  it('honors extra words from config', () => {
    expect(detectAbuse('that is bakwaas', ['bakwaas']).abusive).toBe(true);
  });
});

describe('pickVariant', () => {
  it('picks deterministically with an injected rng, empty -> ""', () => {
    expect(pickVariant(['a', 'b', 'c'], () => 0)).toBe('a');
    expect(pickVariant(['a', 'b', 'c'], () => 0.99)).toBe('c');
    expect(pickVariant([], () => 0)).toBe('');
  });
});

describe('verifyMetaSignature', () => {
  const secret = 'app-secret';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const good = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  it('accepts a correct signature', () => {
    expect(verifyMetaSignature(body, good, secret)).toBe(true);
  });
  it('rejects a wrong signature, wrong secret, or missing header', () => {
    expect(verifyMetaSignature(body, 'sha256=deadbeef', secret)).toBe(false);
    expect(verifyMetaSignature(body, good, 'other-secret')).toBe(false);
    expect(verifyMetaSignature(body, '', secret)).toBe(false);
  });
});

describe('parseCommentEvents', () => {
  it('parses an Instagram comment', () => {
    const body = {
      object: 'instagram',
      entry: [{
        id: 'ig_acct_1',
        time: 1700000000,
        changes: [{
          field: 'comments',
          value: { id: 'ig_c1', text: 'want', from: { id: 'u1', username: 'alice' }, media: { id: 'media99' } },
        }],
      }],
    };
    const [e] = parseCommentEvents(body);
    expect(e).toMatchObject({ platform: 'instagram', commentId: 'ig_c1', postId: 'media99', commenterId: 'u1', commenterUsername: 'alice', text: 'want' });
    expect(e.accountId).toBe('ig_acct_1'); // entry.id = the owning account (DM path + token key)
    expect(e.createdAt).toBeInstanceOf(Date); // fell back to entry.time
  });
  it('parses a Facebook page comment and ignores non-comment feed items', () => {
    const body = {
      object: 'page',
      entry: [{
        changes: [
          { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'fb_c1', post_id: 'p1', from: { id: 'u2', name: 'Bob' }, message: 'price?', created_time: 1700000000 } },
          { field: 'feed', value: { item: 'like', verb: 'add' } },
        ],
      }],
    };
    const events = parseCommentEvents(body);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ platform: 'facebook', commentId: 'fb_c1', postId: 'p1', commenterUsername: 'Bob', text: 'price?' });
  });
  it('returns [] for junk', () => {
    expect(parseCommentEvents(null)).toEqual([]);
    expect(parseCommentEvents({ object: 'instagram' })).toEqual([]);
  });
});
