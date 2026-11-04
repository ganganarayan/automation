import { describe, it, expect } from 'vitest';
import { commentStatus } from '../src/utils/laneSpec.js';

const ok = { id: 'a1', state: 'ok' };

describe('commentStatus', () => {
  it('confirms a posted comment', () => {
    expect(commentStatus(ok, [{ status: 'done', done: { a1: { state: 'ok' } } }])).toBe('🟢 Comment posted');
  });

  it('a retried post counts if any attempt commented', () => {
    const jobs = [{ status: 'failed', done: { a1: { state: 'failed', error: 'x' } } }, { status: 'done', done: { a1: { state: 'ok' } } }];
    expect(commentStatus(ok, jobs)).toBe('🟢 Comment posted');
  });

  it('gives the reason for a failure or a skip', () => {
    expect(commentStatus(ok, [{ status: 'failed', done: { a1: { state: 'failed', error: 'no token' } } }])).toBe('🔴 Comment failed: no token');
    expect(commentStatus(ok, [{ status: 'done', done: { a1: { state: 'skipped', error: 'tiktok has no comment API' } } }])).toBe('⚪ No comment: tiktok has no comment API');
  });

  it('tells waiting, not recorded and never queued apart', () => {
    expect(commentStatus(ok, [{ status: 'pending', done: {} }])).toBe('⏳ Comment waiting');
    expect(commentStatus(ok, [{ status: 'pending', done: { a1: { state: 'sending' } } }])).toBe('⏳ Comment waiting');
    expect(commentStatus(ok, [{ status: 'done', done: { other: { state: 'ok' } } }])).toBe('🟡 Comment not recorded');
    expect(commentStatus(ok, [])).toBe('⚪ No comment queued');
  });

  it('says nothing for a channel that did not post', () => {
    expect(commentStatus({ id: 'a1', state: 'failed' }, [{ done: { a1: { state: 'ok' } } }])).toBe('');
  });
});
