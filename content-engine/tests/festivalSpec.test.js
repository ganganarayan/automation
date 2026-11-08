import { describe, it, expect } from 'vitest';
import { festivalCaptions, stateOf, X_LIMIT } from '../src/utils/festivalSpec.js';
import { laneOf } from '../src/utils/laneSpec.js';
import { retryAction } from '../src/utils/retrySpec.js';

describe('festivalCaptions', () => {
  it('keeps a short copy whole on every channel', () => {
    expect(festivalCaptions('  Happy Diwali!  ')).toEqual({ full: 'Happy Diwali!', short: 'Happy Diwali!' });
  });
  it('cuts a long copy for X at a word, within 280', () => {
    const copy = 'Diwali '.repeat(60).trim();
    const { full, short } = festivalCaptions(copy);
    expect(full).toBe(copy);
    expect(short.length).toBeLessThanOrEqual(X_LIMIT);
    expect(short.endsWith('Diwali…')).toBe(true);
  });
  it('is empty for no copy', () => {
    expect(festivalCaptions()).toEqual({ full: '', short: '' });
  });
});

describe('stateOf', () => {
  it('reads a scheduled post in IST, Indian date order', () => {
    expect(stateOf({ status: 'scheduled', scheduledFor: '2026-11-08T02:30:00Z' })).toEqual({ dot: '🟢', text: 'Scheduled for 08-11-2026 08:00' });
  });
  it('marks a failure red with its reason', () => {
    expect(stateOf({ status: 'failed', note: 'no voice' })).toEqual({ dot: '🔴', text: 'Failed: no voice' });
  });
  it('says an auto-post is posting, a checked one is waiting', () => {
    expect(stateOf({ status: 'image_review', autoPost: true }).text).toBe('Video made, posting');
    expect(stateOf({ status: 'image_review' }).text).toBe('Video made, waiting for your approval');
  });
});

describe('festival lane wiring', () => {
  it('is its own lane', () => {
    expect(laneOf({ source_type: 'festival' })).toBe('festival');
  });
  it('retries on its own, never through a router day', () => {
    expect(retryAction({ source_type: 'festival', status: 'failed' }, [])).toBe('festival');
  });
});
