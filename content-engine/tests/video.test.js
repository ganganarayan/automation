import { describe, it, expect } from 'vitest';
import { probeMp4DurationSeconds, seededPersona, buildVideoImagePrompts, buildMovieSpec } from '../src/utils/videoSpec.js';

describe('probeMp4DurationSeconds', () => {
  it('returns the fallback when no mvhd atom is present', () => {
    expect(probeMp4DurationSeconds(Buffer.from('no atoms here'), 42)).toBe(42);
  });

  it('parses a version-0 mvhd duration', () => {
    // Build a minimal buffer: 'mvhd' + version/flags(4) + created(4) + modified(4) + timescale(4) + duration(4)
    const buf = Buffer.alloc(64);
    const idx = 8;
    buf.write('mvhd', idx);
    buf[idx + 4] = 0; // version 0
    buf.writeUInt32BE(1000, idx + 4 + 12); // timescale
    buf.writeUInt32BE(50000, idx + 4 + 16); // duration => 50s
    expect(probeMp4DurationSeconds(buf)).toBe(50);
  });
});

describe('seededPersona', () => {
  it('is deterministic for the same seed', () => {
    expect(seededPersona(7, 'founders')).toEqual(seededPersona(7, 'founders'));
  });
  it('infers role from audience keywords', () => {
    expect(seededPersona(1, 'startup founder').role).toBe('a company founder');
    expect(seededPersona(1, 'school educator').role).toBe('an educator');
  });
});

describe('buildVideoImagePrompts', () => {
  it('builds four consistent-person prompts', () => {
    const prompts = buildVideoImagePrompts(seededPersona(3, 'doctor'));
    expect(prompts).toHaveLength(4);
    expect(prompts.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
  });
});

describe('buildMovieSpec', () => {
  it('produces a 1080x1920 spec with an audio track and scenes', () => {
    const spec = buildMovieSpec({
      voiceoverUrl: 'https://x/v.mp4',
      imageUrls: ['a', 'b', 'c', 'd'],
      durationSeconds: 40,
      ctaTime: '30',
      sthiraTime: '10',
    });
    expect(spec.width).toBe(1080);
    expect(spec.height).toBe(1920);
    expect(spec.elements[0].type).toBe('audio');
    expect(spec.scenes.length).toBeGreaterThanOrEqual(4);
  });
});
