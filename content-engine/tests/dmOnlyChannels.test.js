import { describe, it, expect } from 'vitest';
import { dmOnly } from '../src/services/firstCommentSenders.js';
import { commentStatus } from '../src/utils/laneSpec.js';

describe('dmOnly', () => {
  it('sends the Instagram link by DM, whatever Post for Me calls the platform', () => {
    expect(dmOnly('instagram')).toBe(true);
    expect(dmOnly('instagram_reels')).toBe(true);
  });

  it('keeps first comments on every other channel', () => {
    for (const p of ['facebook', 'youtube', 'linkedin', 'threads', 'x', 'twitter', 'tiktok', '']) expect(dmOnly(p)).toBe(false);
  });

  it('shows on the log as no comment, with the reason', () => {
    const jobs = [{ status: 'done', done: { a1: { state: 'skipped', error: 'Instagram sends the link by comment-to-DM' } } }];
    expect(commentStatus({ id: 'a1', state: 'ok' }, jobs)).toBe('⚪ No comment: Instagram sends the link by comment-to-DM');
  });
});
