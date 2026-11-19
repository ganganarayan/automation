import { describe, it, expect } from 'vitest';
import { canMoveText } from '../src/utils/moveTextSpec.js';

const images = (artifacts) => [{ key: 'images', status: 'done', artifacts }];

describe('Move the text', () => {
  it('works on a post made from a video still', () => {
    expect(canMoveText(images({ stepDown: { from: 'animate' } }))).toBe(true);
  });
  it('works on a sheet post that kept its no-text pictures and words', () => {
    expect(canMoveText(images({ bare: { feed: { driveId: 'a' } }, words: { headline: 'Your jaw' } }))).toBe(true);
  });
  it('is refused when the pictures without text or the words were not kept', () => {
    expect(canMoveText(images({}))).toBe(false);
    expect(canMoveText(images({ bare: { feed: { driveId: 'a' } }, words: {} }))).toBe(false);
    expect(canMoveText(images({ bare: {}, words: { headline: 'x' } }))).toBe(false);
    expect(canMoveText([])).toBe(false);
  });
});
