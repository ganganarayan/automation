import { describe, it, expect } from 'vitest';
import { MUSIC_TRACKS, MUSIC_OPTIONS, pickMusic, musicLink, shortTitle, imageShortArgs, DEFAULT_MUSIC, imageVideoMode, voiceText, imageVideoSeconds, imageVideoConfigs, IMAGE_VIDEO_SECONDS, VOICE_MAX_CHARS } from '../src/utils/shortSpec.js';
import { stepDownFallback, platformConfigsFor } from '../src/utils/aiCopySpec.js';
import { nextAutoRetry } from '../src/utils/laneSpec.js';
import { retryAction } from '../src/utils/retrySpec.js';

describe('music for the Short', () => {
  it('offers every track and your own file', () => {
    expect(MUSIC_OPTIONS.map((o) => o.value)).toEqual([...MUSIC_TRACKS.map((t) => t.value), 'own']);
  });

  it('falls back to the default on a blank or unknown choice, or own with no link', () => {
    const def = MUSIC_TRACKS.find((t) => t.value === DEFAULT_MUSIC).expr;
    for (const m of [{}, { track: 'gone' }, { track: 'own' }, { track: 'own', url: 'not a link' }]) expect(pickMusic(m)).toEqual({ expr: def });
  });

  it('uses your own file only when it is picked', () => {
    expect(pickMusic({ track: 'own', url: 'https://x/a.mp3' })).toEqual({ url: 'https://x/a.mp3' });
    expect(pickMusic({ track: 'tanpura', url: 'https://x/a.mp3' }).expr).toBeTruthy();
  });

  it('turns a Drive share link into its download link', () => {
    expect(musicLink('https://drive.google.com/file/d/abcDEF12345_-/view?usp=sharing')).toBe('https://drive.usercontent.google.com/download?id=abcDEF12345_-&export=download&confirm=t');
  });

  it('keeps every expression free of quotes that would break the filter', () => {
    for (const t of MUSIC_TRACKS) expect(t.expr).not.toMatch(/['"]/);
  });
});

describe('imageShortArgs', () => {
  it('generates the music and fades it out at the end', () => {
    const a = imageShortArgs({ imagePath: 'i.png', outPath: 'o.mp4', music: { expr: 'sin(t)' }, seconds: 10 });
    expect(a).toContain("aevalsrc=exprs='sin(t)':s=44100:c=stereo");
    expect(a[a.indexOf('-filter_complex') + 1]).toContain('afade=t=out:st=8:d=2');
    expect(a[a.indexOf('-t') + 1]).toBe('10');
    expect(a.at(-1)).toBe('o.mp4');
  });

  it('loops your own file instead', () => {
    const a = imageShortArgs({ imagePath: 'i.png', outPath: 'o.mp4', music: { file: 'm' } });
    expect(a.slice(a.indexOf('-stream_loop'), a.indexOf('-stream_loop') + 4)).toEqual(['-stream_loop', '-1', '-i', 'm']);
    expect(a.join(' ')).not.toContain('aevalsrc');
  });
});

describe('shortTitle', () => {
  it('uses the instance title without its date, else the first line of text without its link, up to 100 characters', () => {
    expect(shortTitle('Head · 06-11-2026', 'text')).toBe('Head');
    expect(shortTitle('Image post · 06-11-2026', 'First')).toBe('First');
    expect(shortTitle('', 'First line https://x.io\nsecond')).toBe('First line');
    expect(shortTitle('h'.repeat(150)).length).toBe(100);
    expect(shortTitle('', '')).toBe('Short');
  });
});

describe('X steps down like Threads', () => {
  const now = new Date('2026-11-06T00:00:00Z');

  it('goes to picture then text', () => {
    const one = stepDownFallback('x', { x: { caption: 'S', media: [{ url: 'https://v', thumbnail_url: 'https://t.jpg' }] } }, 'long');
    expect(one.as).toBe('image and text');
    expect(stepDownFallback('x', { x: one.config }, 'long', one.as)).toEqual({ config: { caption: 'S' }, as: 'text only' });
  });

  it('clips a shared caption to the X limit', () => {
    expect(stepDownFallback('x', {}, 'y'.repeat(2000)).config.caption.length).toBeLessThanOrEqual(280);
  });

  it('skips the video only past 20 minutes', () => {
    const args = { accountIds: ['a'], accountMap: { a: { platform: 'x' } }, videoUrl: 'https://v', thumbs: { x: 'https://t.jpg' } };
    const copy = { title: 'T', description: 'D', igCaption: 'I', short: 'S' };
    expect(platformConfigsFor(copy, { ...args, durationSec: 533 }).platformConfigurations.x.media[0].url).toBe('https://v');
    expect(platformConfigsFor(copy, { ...args, durationSec: 1201 }).platformConfigurations.x.media).toEqual([{ url: 'https://t.jpg' }]);
  });

  it('retries any X failure until text has been tried', () => {
    expect(nextAutoRetry([{ platform: 'x', state: 'failed', error: 'nope' }], 0, now)).not.toBeNull();
    expect(nextAutoRetry([{ platform: 'Twitter', state: 'failed', error: 'nope' }], 0, now)).not.toBeNull();
    expect(nextAutoRetry([{ platform: 'x', state: 'failed', error: 'nope', as: 'text only' }], 0, now)).toBeNull();
  });
});

describe('a failed Short on an image post', () => {
  it('can be retried', () => {
    const steps = [{ key: 'publish', artifacts: { channels: [{ platform: 'youtube', state: 'failed' }] } }];
    expect(retryAction({ status: 'partial', source_type: 'sheet' }, steps)).toBe('channels');
  });
});

describe('image post as a video', () => {
  it('defaults to video with voice', () => {
    expect(imageVideoMode('')).toBe('on');
    expect(imageVideoMode('junk')).toBe('on');
    expect(imageVideoMode('music')).toBe('music');
    expect(imageVideoMode('off')).toBe('off');
  });

  it('reads the caption without links, hashtags, mentions or emoji', () => {
    const t = voiceText('Stay calm 🙏\nRead more https://x.co/a #gita #wisdom @someone\nDo your duty.');
    expect(t).toBe('Stay calm. Read more. Do your duty.');
    expect(voiceText('#only #tags https://x.co')).toBe('');
  });

  it('cuts a long caption at a sentence end', () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} here.`).join(' ');
    const t = voiceText(long);
    expect(t.length).toBeLessThanOrEqual(VOICE_MAX_CHARS);
    expect(t.endsWith('.')).toBe(true);
  });

  it('is 8 s, or the voice plus 1.5 s, up to 60 s', () => {
    expect(imageVideoSeconds(0)).toBe(IMAGE_VIDEO_SECONDS);
    expect(imageVideoSeconds(4)).toBe(8);
    expect(imageVideoSeconds(12.2)).toBe(14);
    expect(imageVideoSeconds(200)).toBe(60);
  });

  it('mixes the voice over quieter music', () => {
    const a = imageShortArgs({ imagePath: 'i.png', outPath: 'o.mp4', music: { expr: 'sin(t)' }, seconds: 14, voicePath: 'v.mp3' });
    const f = a[a.indexOf('-filter_complex') + 1];
    expect(a.slice(a.indexOf('v.mp3') - 1, a.indexOf('v.mp3') + 1)).toEqual(['-i', 'v.mp3']);
    expect(f).toContain('volume=0.25');
    expect(f).toContain('adelay=500|500');
    expect(f).toContain('amix=inputs=2:duration=first');
    expect(f).toContain('afade=t=out:st=12:d=2');
    expect(a[a.indexOf('-t') + 1]).toBe('14');
  });

  it('gives each platform the video with the picture as cover, long text where there is room', () => {
    const c = imageVideoConfigs({ platforms: ['youtube', 'instagram', 'linkedin', 'x', 'youtube'], full: 'F', short: 'S', title: 'T', videoUrl: 'v', imageUrl: 'i' });
    expect(Object.keys(c)).toEqual(['youtube', 'instagram', 'linkedin', 'x']);
    expect(c.youtube).toEqual({ caption: 'F', title: 'T', media: [{ url: 'v', thumbnail_url: 'i' }] });
    expect(c.instagram.caption).toBe('S');
    expect(c.linkedin.caption).toBe('F');
    // X steps down to the picture and text when the video is refused.
    expect(stepDownFallback('x', c, 'S').as).toBe('image and text');
    expect(stepDownFallback('x', c, 'S').config.media).toEqual([{ url: 'i' }]);
  });
});
