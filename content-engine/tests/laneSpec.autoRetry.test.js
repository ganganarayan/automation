import { describe, it, expect } from 'vitest';
import { isRecoverableError, nextAutoRetry, requestFromPost, AUTO_RETRY_MINUTES } from '../src/utils/laneSpec.js';

const meta = 'Account needs to be reconnected: Error validating access token: The session has been invalidated';

describe('isRecoverableError', () => {
  it('treats revoked tokens and outages as recoverable', () => {
    expect(isRecoverableError(meta)).toBe(true);
    expect(isRecoverableError('503 Service Unavailable')).toBe(true);
    expect(isRecoverableError('Video is longer than 90 seconds')).toBe(false);
  });
});

describe('nextAutoRetry', () => {
  const now = new Date('2026-10-31T10:00:00Z');
  const chans = [{ state: 'ok' }, { state: 'failed', error: meta }];
  it('backs off by the schedule and stops after the last try', () => {
    expect(nextAutoRetry(chans, 0, now)).toBe('2026-10-31T11:00:00.000Z');
    expect(nextAutoRetry(chans, 1, now)).toBe('2026-10-31T13:00:00.000Z');
    expect(nextAutoRetry(chans, AUTO_RETRY_MINUTES.length, now)).toBe(null);
  });
  it('does not retry unrecoverable or absent failures', () => {
    expect(nextAutoRetry([{ state: 'failed', error: 'video too long' }], 0, now)).toBe(null);
    expect(nextAutoRetry([{ state: 'ok' }], 0, now)).toBe(null);
  });
});

describe('requestFromPost', () => {
  it('rebuilds caption, media and platform configs', () => {
    const r = requestFromPost({ caption: 'hi', media: [{ url: 'https://v/1.mp4' }], platform_configurations: { youtube: { title: 'T' }, x: null } });
    expect(r).toEqual({ caption: 'hi', mediaUrl: 'https://v/1.mp4', platformConfigurations: { youtube: { title: 'T' } } });
  });
  it('gives null without media', () => {
    expect(requestFromPost({ caption: 'hi', media: [] })).toBe(null);
    expect(requestFromPost(null)).toBe(null);
  });
});
