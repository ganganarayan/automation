import { describe, it, expect } from 'vitest';
import { animWindow, animTaps, animLayout, animFrameSvg, soundFilters, ANIM_STYLES, ANIM_SEC } from '../src/utils/ctaAnimSpec.js';

describe('when the animation plays', () => {
  it('only on videos over 3 minutes, 10 s before the line', () => {
    expect(animWindow(180, 88)).toBeNull();
    expect(animWindow(240, 118)).toEqual({ start: 108, end: 108 + ANIM_SEC });
  });
});

describe('per channel', () => {
  it('YouTube says Subscribe and rings the bell, TikTok follows with no bell', () => {
    expect(ANIM_STYLES.youtube.button).toBe('SUBSCRIBE');
    expect(animTaps('youtube').map((t) => t.sound)).toEqual(['click', 'click', 'bell']);
    expect(animTaps('tiktok').map((t) => t.sound)).toEqual(['click', 'click']);
  });
  it('sits inside the frame: upper middle when tall, bottom left when wide', () => {
    for (const p of Object.keys(ANIM_STYLES)) {
      for (const [w, h] of [[1080, 1920], [1080, 1350], [1920, 1080]]) {
        const l = animLayout({ w, h, platform: p });
        expect(l.x).toBeGreaterThanOrEqual(0);
        expect(l.x + l.boxW).toBeLessThanOrEqual(w);
        expect(l.y + l.boxH).toBeLessThanOrEqual(h);
      }
    }
    expect(animLayout({ w: 1080, h: 1920, platform: 'youtube' }).y).toBeLessThan(1920 * 0.3);
    expect(animLayout({ w: 1920, h: 1080, platform: 'youtube' }).y).toBeGreaterThan(1080 * 0.5);
  });
  it('shows the done words after the button tap', () => {
    const layout = animLayout({ platform: 'youtube' });
    expect(animFrameSvg({ platform: 'youtube', t: 1.0, layout })).toContain('>SUBSCRIBE<');
    expect(animFrameSvg({ platform: 'youtube', t: 2.0, layout })).toContain('>SUBSCRIBED<');
    expect(animFrameSvg({ platform: 'youtube', t: ANIM_SEC, layout })).not.toContain('<text');
  });
});

describe('sounds', () => {
  it('each tap delayed to its moment in the video', () => {
    const f = soundFilters(animTaps('youtube'), 100);
    expect(f).toHaveLength(3);
    expect(f[0]).toContain('adelay=delays=100800:all=1');
    expect(f[2]).toContain('adelay=delays=102600:all=1');
    expect(f[2]).toMatch(/\[s2\]$/);
    expect(f.join('')).toMatch(/aevalsrc='[^']+'/);
  });
});
