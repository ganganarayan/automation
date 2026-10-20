import { describe, it, expect } from 'vitest';
import {
  mapImageSize,
  clampCount,
  defaultScenePrompts,
  buildImageName,
  selectKept,
  partitionByRegen,
} from '../src/utils/imageGateSpec.js';

describe('mapImageSize', () => {
  it('maps square and defaults everything else to portrait', () => {
    expect(mapImageSize('square')).toBe('1024x1024');
    expect(mapImageSize('portrait')).toBe('1024x1536');
    expect(mapImageSize('')).toBe('1024x1536');
    expect(mapImageSize(undefined)).toBe('1024x1536');
  });
});

describe('clampCount', () => {
  it('clamps into [1,12] and falls back on junk', () => {
    expect(clampCount('5')).toBe(5);
    expect(clampCount(0)).toBe(4);
    expect(clampCount(99)).toBe(12);
    expect(clampCount('abc', 3)).toBe(3);
    expect(clampCount(undefined, 6)).toBe(6);
  });
});

describe('defaultScenePrompts', () => {
  it('builds count non-empty prompts with topic and style', () => {
    const p = defaultScenePrompts({ count: 3, style: 'cinematic', topic: 'dharma' });
    expect(p).toHaveLength(3);
    expect(p.every((x) => x.includes('dharma') && x.includes('cinematic'))).toBe(true);
    expect(p[0]).toContain('scene 1 of 3');
  });
  it('still produces prompts with no topic/style', () => {
    const p = defaultScenePrompts({ count: 2 });
    expect(p).toHaveLength(2);
    expect(p.every((x) => x.length > 0)).toBe(true);
  });
});

describe('buildImageName', () => {
  it('sanitizes and composes a png name', () => {
    expect(buildImageName('img', 0, 'abc')).toBe('img-abc-0.png');
    expect(buildImageName('a b/c', 2, 'z')).toBe('a-b-c-z-2.png');
  });
});

describe('selectKept', () => {
  const imgs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('keeps everything when no ids given', () => {
    expect(selectKept(imgs, [])).toHaveLength(3);
    expect(selectKept(imgs, undefined)).toHaveLength(3);
  });
  it('keeps only the listed ids', () => {
    expect(selectKept(imgs, ['a', 'c']).map((x) => x.id)).toEqual(['a', 'c']);
  });
});

describe('partitionByRegen', () => {
  it('splits images by the regenerate set', () => {
    const imgs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const { keep, regen } = partitionByRegen(imgs, ['b']);
    expect(keep.map((x) => x.id)).toEqual(['a', 'c']);
    expect(regen.map((x) => x.id)).toEqual(['b']);
  });
});
