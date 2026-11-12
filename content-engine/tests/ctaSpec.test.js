import { describe, it, expect } from 'vitest';
import {
  ctaLines, normalizeVideoCta, ctaPlan, ctaGroups, ctaWindow, ctaBannerSvg, ctaOverlayArgs,
  videoPlatforms, withCtaVideos, pointVideos, DEFAULT_CTA, wrapCta,
} from '../src/utils/ctaSpec.js';

describe('call to action lines', () => {
  it('uses typed lines, trimmed, at most five', () => {
    expect(ctaLines(' Subscribe now \n\n Hit the bell \n', 'youtube')).toEqual(['Subscribe now', 'Hit the bell']);
    expect(ctaLines('a\nb\nc\nd\ne\nf', 'x')).toHaveLength(5);
  });
  it('falls back to the built-in lines when blank', () => {
    expect(ctaLines('', 'youtube')).toEqual(DEFAULT_CTA.youtube);
    expect(DEFAULT_CTA.youtube.every((l) => /subscribe/i.test(l))).toBe(true);
  });
  it('is off unless switched on, 4 s by default', () => {
    expect(normalizeVideoCta({}).on).toBe(false);
    expect(normalizeVideoCta({ on: 'on', sec: '6' })).toMatchObject({ on: true, sec: 6 });
    expect(normalizeVideoCta({ on: 'on', sec: '99' }).sec).toBe(4);
  });
});

describe('rotation', () => {
  const lists = normalizeVideoCta({ on: 'on' }).lists;
  it('takes the next line each video and wraps round', () => {
    const texts = [0, 1, 2, 3].map((turn) => ctaPlan({ platforms: ['youtube'], lists, turn }).youtube);
    expect(texts).toEqual([...DEFAULT_CTA.youtube, DEFAULT_CTA.youtube[0]]);
  });
  it('groups channels with the same line into one render', () => {
    const plan = ctaPlan({ platforms: ['youtube', 'instagram', 'tiktok', 'x', 'facebook'], lists, turn: 0 });
    const groups = ctaGroups(plan);
    expect(groups.size).toBe(3);
    expect(groups.get(DEFAULT_CTA.instagram[0])).toEqual(['instagram', 'tiktok', 'x']);
  });
});

describe('timing and picture', () => {
  it('sits in the middle of the video', () => {
    expect(ctaWindow(60, 4)).toEqual({ start: 28, end: 32 });
    expect(ctaWindow(6, 4)).toBeNull();
  });
  it('draws an escaped pill, YouTube in red', () => {
    const svg = ctaBannerSvg({ w: 1080, h: 1920, text: 'Subscribe & stay <tuned>', platform: 'youtube' });
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;tuned&gt;');
    expect(svg).toContain('#E62117');
    expect(svg).not.toMatch(/<rect[^>]*width="1080"/);
  });
  it('wraps long lines to two', () => {
    expect(wrapCta('one two three four five six seven', 10, 2)).toHaveLength(2);
  });
  it('overlays only inside the window and copies the sound', () => {
    const args = ctaOverlayArgs({ input: 'https://x/v.mp4', overlay: 'o.png', output: 'out.mp4', start: 28, end: 32, fps: 30 });
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain("enable='between(t,28,32)'");
    expect(graph).toContain('fade=t=in:st=28');
    expect(graph).toContain('fade=t=out:st=31.65');
    expect(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2)).toEqual(['-c:a', 'copy']);
    expect(args).toContain('0:a?');
  });
});

describe('per-channel videos', () => {
  const video = 'https://drive/video';
  const configs = {
    youtube: { title: 't', caption: 'c', media: [{ url: video, thumbnail_url: 'https://thumb/yt' }] },
    instagram: { caption: 'c', media: [{ url: video, thumbnail_timestamp_ms: 0 }] },
    x: { caption: 'c', media: [{ url: 'https://art/picture' }] },
    linkedin: { caption: 'c' },
  };
  it('only channels posting the video get a copy', () => {
    expect(videoPlatforms(configs, video)).toEqual(['youtube', 'instagram']);
  });
  it('swaps in each copy and keeps thumbnails', () => {
    const out = withCtaVideos(configs, video, { youtube: 'https://cta/yt', instagram: 'https://cta/ig', x: 'https://cta/x' });
    expect(out.youtube.media[0]).toEqual({ url: 'https://cta/yt', thumbnail_url: 'https://thumb/yt' });
    expect(out.instagram.media[0]).toEqual({ url: 'https://cta/ig', thumbnail_timestamp_ms: 0 });
    expect(out.x).toBe(configs.x);
    expect(out.linkedin).toBe(configs.linkedin);
  });
  it('points copies back at a new source before redoing them', () => {
    const out = pointVideos({ youtube: { media: [{ url: 'https://cta/yt', thumbnail_url: 'k' }] } }, ['youtube', 'tiktok'], 'https://clean');
    expect(out.youtube.media[0]).toEqual({ url: 'https://clean', thumbnail_url: 'k' });
    expect(out.tiktok).toBeUndefined();
  });
});
