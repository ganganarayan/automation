import { describe, it, expect } from 'vitest';
import { retryPasses, retryNote, buildTimeline } from '../src/utils/stepTimeSpec.js';

describe('every Retry pass is on the Log', () => {
  it('counts retry marks only', () => {
    const log = [
      { k: 'retry', s: 'mark', at: '2026-11-17T10:00:00Z', note: 'Retry pass 1' },
      { k: 'failed', s: 'mark', at: '2026-11-17T10:01:00Z', note: 'Failed: x' },
      { k: 'retry', s: 'mark', at: '2026-11-17T11:00:00Z', note: 'Retry pass 2' },
      { k: 'images', s: 'start', at: '2026-11-17T11:00:01Z' },
    ];
    expect(retryPasses(log)).toBe(2);
    expect(retryPasses(JSON.stringify(log))).toBe(2);
    expect(retryPasses(null)).toBe(0);
  });
  it('the line says the pass, who, what and the error it replaces', () => {
    const n = retryNote({ pass: 3, by: 'a@b.c', action: 'images', lastError: 'images: 429\n Too Many Requests' });
    expect(n).toBe('Retry pass 3 by a@b.c: run again from images. Error before it: images: 429 Too Many Requests');
    expect(retryNote({ pass: 1, action: 'channels' })).toBe('Retry pass 1: post again to the failed channels.');
  });
  it('the marks show on the Steps timeline in order', () => {
    const log = [
      { k: 'retry', s: 'mark', at: '2026-11-17T10:00:00Z', note: 'Retry pass 1' },
      { k: 'failed', s: 'mark', at: '2026-11-17T10:01:00Z', note: 'Failed: quota' },
    ];
    const labels = buildTimeline({ status: 'failed', created_at: '2026-11-17T09:00:00Z' }, [], log).filter((e) => e.kind === 'mark').map((e) => e.label);
    expect(labels).toEqual(['Retry pass 1', 'Failed: quota']);
  });
});
