import { describe, it, expect } from 'vitest';
import { platformConfigsFor, threadsFallback } from '../src/utils/aiCopySpec.js';
import { nextAutoRetry, channelText } from '../src/utils/laneSpec.js';

const copy = { title: 'T', description: 'D', igCaption: 'I', short: 'S' };
const accountMap = { a: { platform: 'threads' }, b: { platform: 'youtube' } };
const args = { accountIds: ['a', 'b'], accountMap, videoUrl: 'https://v', thumbs: { youtube: 'https://yt.jpg' } };

describe('a video too long for Threads', () => {
  it('sends the picture and text to Threads, the video everywhere else', () => {
    const { platformConfigurations: pc, posted } = platformConfigsFor(copy, { ...args, durationSec: 533 });
    expect(pc.threads.media).toEqual([{ url: 'https://yt.jpg' }]);
    expect(pc.threads.caption).toBe('S');
    expect(pc.youtube.media).toEqual([{ url: 'https://v', thumbnail_url: 'https://yt.jpg' }]);
    expect(posted).toEqual({ threads: 'image and text' });
  });

  it('keeps the video at exactly 5 minutes or when the length is unknown', () => {
    for (const durationSec of [300, 0]) {
      const { platformConfigurations: pc, posted } = platformConfigsFor(copy, { ...args, durationSec });
      expect(pc.threads.media[0].url).toBe('https://v');
      expect(posted).toEqual({});
    }
  });

  it('tries the video when there is no picture to send', () => {
    const { platformConfigurations: pc } = platformConfigsFor(copy, { ...args, thumbs: {}, durationSec: 533 });
    expect(pc.threads.media[0].url).toBe('https://v');
  });
});

describe('threadsFallback', () => {
  const video = { threads: { caption: 'S', media: [{ url: 'https://v', thumbnail_url: 'https://t.jpg' }] } };

  it('steps from video to picture to text', () => {
    const one = threadsFallback(video, 'long');
    expect(one).toEqual({ config: { caption: 'S', media: [{ url: 'https://t.jpg' }] }, as: 'image and text' });
    const two = threadsFallback({ threads: one.config }, 'long', one.as);
    expect(two).toEqual({ config: { caption: 'S' }, as: 'text only' });
    expect(threadsFallback({ threads: two.config }, 'long', two.as).as).toBe('text only');
  });

  it("borrows another platform's picture, and does not step back up from text", () => {
    const configs = { threads: { caption: 'S', media: [{ url: 'https://v', thumbnail_timestamp_ms: 0 }] }, youtube: { media: [{ url: 'https://v', thumbnail_url: 'https://yt.jpg' }] } };
    expect(threadsFallback(configs, '').config.media).toEqual([{ url: 'https://yt.jpg' }]);
    expect(threadsFallback(configs, '', 'text only').config.media).toBeUndefined();
  });

  it('clips the shared caption to fit Threads when there is no saved copy', () => {
    const { config, as } = threadsFallback({}, 'x'.repeat(2000));
    expect(as).toBe('text only');
    expect(config.caption.length).toBeLessThanOrEqual(500);
  });
});

describe('automatic retry for Threads', () => {
  const now = new Date('2026-11-06T00:00:00Z');
  const threads = { platform: 'threads', state: 'failed', error: 'video too long' };

  it('retries any Threads failure until text has been tried', () => {
    expect(nextAutoRetry([threads], 0, now)).not.toBeNull();
    expect(nextAutoRetry([{ ...threads, as: 'image and text' }], 0, now)).not.toBeNull();
    expect(nextAutoRetry([{ ...threads, as: 'text only' }], 0, now)).toBeNull();
  });

  it('leaves other platforms as they were', () => {
    expect(nextAutoRetry([{ platform: 'x', state: 'failed', error: 'video too long' }], 0, now)).toBeNull();
  });

  it('shows what actually went out', () => {
    expect(channelText({ platform: 'threads', name: 'G', state: 'ok', as: 'image and text' })).toBe('✅ threads G [image and text]');
  });
});
