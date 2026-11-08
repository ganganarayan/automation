import { describe, it, expect } from 'vitest';
import { festivalCaptions, stateOf, overlayBox, X_LIMIT } from '../src/utils/festivalSpec.js';
import { laneOf } from '../src/utils/laneSpec.js';
import { retryAction } from '../src/utils/retrySpec.js';

describe('festivalCaptions', () => {
  it('keeps a short copy whole on every channel', () => {
    expect(festivalCaptions('  Happy Diwali!  ')).toEqual({ full: 'Happy Diwali!', short: 'Happy Diwali!' });
  });
  it('cuts a long copy for X at a word, within 280', () => {
    const copy = 'Diwali '.repeat(60).trim();
    const { full, short } = festivalCaptions(copy);
    expect(full).toBe(copy);
    expect(short.length).toBeLessThanOrEqual(X_LIMIT);
    expect(short.endsWith('Diwali…')).toBe(true);
  });
  it('is empty for no copy', () => {
    expect(festivalCaptions()).toEqual({ full: '', short: '' });
  });
});

describe('stateOf', () => {
  it('reads a scheduled post in IST, Indian date order', () => {
    expect(stateOf({ status: 'scheduled', scheduledFor: '2026-11-08T02:30:00Z' })).toEqual({ dot: '🟢', text: 'Scheduled for 08-11-2026 08:00' });
  });
  it('marks a failure red with its reason', () => {
    expect(stateOf({ status: 'failed', note: 'no voice' })).toEqual({ dot: '🔴', text: 'Failed: no voice' });
  });
  it('says an auto-post is posting, a checked one is waiting', () => {
    expect(stateOf({ status: 'image_review', autoPost: true }).text).toBe('Video made, posting');
    expect(stateOf({ status: 'image_review' }).text).toBe('Video made, waiting for your approval');
  });
});

describe('festival lane wiring', () => {
  it('is its own lane', () => {
    expect(laneOf({ source_type: 'festival' })).toBe('festival');
  });
  it('retries on its own, never through a router day', () => {
    expect(retryAction({ source_type: 'festival', status: 'failed' }, [])).toBe('festival');
  });
});

describe('overlayBox (your photo on the picture)', () => {
  const W = 1000;
  const H = 1250;
  it('stands on the bottom edge, at the right by default, 35% of the height', () => {
    const b = overlayBox({ W, H, w: 400, h: 800 });
    expect(b.height).toBe(438);
    expect(b.width).toBe(219);
    expect(b.top).toBe(H - 438);
    expect(b.left).toBe(W - 219 - 30);
  });
  it('small is 25% of the height, large 50%', () => {
    expect(overlayBox({ W, H, w: 400, h: 800, size: 'small' }).height).toBe(313);
    expect(overlayBox({ W, H, w: 400, h: 800, size: 'large' }).height).toBe(625);
  });
  it('goes left or centre, small or large', () => {
    expect(overlayBox({ W, H, w: 400, h: 800, position: 'left', size: 'small' }).left).toBe(30);
    const c = overlayBox({ W, H, w: 400, h: 800, position: 'center', size: 'large' });
    expect(c.height).toBe(625);
    expect(c.left).toBe(Math.round((W - c.width) / 2));
  });
  it('is never wider than 90% of the picture', () => {
    const b = overlayBox({ W, H, w: 2000, h: 500, size: 'large' });
    expect(b.width).toBe(900);
    expect(b.top + b.height).toBe(H);
  });
});

describe('subtitles above your photo', async () => {
  const { subMarginV, photoSubMargins, imageShortArgs } = await import('../src/utils/shortSpec.js');
  it('keeps the usual place with no photo', () => {
    expect(subMarginV({ width: 1080, height: 1920, aspect: 0.8, photoTop: 0 })).toBe(null);
    expect(photoSubMargins({})).toEqual({});
  });
  it('lifts the line above the head on a 4:5 picture in every size', () => {
    // A small photo (25%) on a 4:5 picture: its top is 75% down the picture.
    const m = photoSubMargins({ aspect: 0.8, photoTop: 0.75 });
    // 9:16: picture 1350 tall from y=285, head at 1297.5, so 622.5 px from the bottom = 93.4 rows (+3.85).
    expect(m.portrait).toBe(98);
    expect(m.feed).toBe(76);
    expect(m.landscape).toBe(78);
  });
  it('never goes below the usual place, nor off the top', () => {
    expect(subMarginV({ width: 1080, height: 1920, aspect: 0.8, photoTop: 0.99 })).toBe(70);
    expect(subMarginV({ width: 1080, height: 1920, aspect: 0.8, photoTop: 0.01 })).toBe(240);
  });
  it('reaches ffmpeg', () => {
    const args = imageShortArgs({ imagePath: 'a.png', outPath: 'o.mp4', subPath: 'subs.srt', marginV: 98, voicePath: 'v.mp3' });
    expect(args.join(' ')).toContain('MarginV=98');
    expect(imageShortArgs({ imagePath: 'a.png', outPath: 'o.mp4', subPath: 'subs.srt', voicePath: 'v.mp3' }).join(' ')).toContain('MarginV=70');
  });
});

describe('festival text placement in the video', async () => {
  const { subtitleFilters, imageShortArgs } = await import('../src/utils/shortSpec.js');
  it('usual posts keep the spoken lines at the bottom', () => {
    expect(subtitleFilters({ width: 1080, height: 1920, subPath: 'subs.srt' })).toBe(",subtitles=subs.srt:force_style='Fontsize=11,Bold=1,Outline=2,Shadow=0,Alignment=2,MarginV=70'");
  });
  it('festival: spoken lines at the top, the title at the bottom above the photo', () => {
    const f = subtitleFilters({ width: 1080, height: 1920, subPath: 'subs.srt', subTop: true, titlePath: 'title.srt', marginV: 98 });
    expect(f).toBe(",subtitles=subs.srt:force_style='Fontsize=11,Bold=1,Outline=2,Shadow=0,Alignment=6,MarginV=36',subtitles=title.srt:force_style='Fontsize=15,Bold=1,Outline=2,Shadow=0,Alignment=2,MarginV=98'");
  });
  it('no subtitles, no title either', () => {
    expect(subtitleFilters({ width: 1920, height: 1080, subPath: '', subTop: true, titlePath: 'title.srt' })).toBe('');
  });
  it('refuses an unsafe title path', () => {
    expect(() => imageShortArgs({ imagePath: 'a.png', outPath: 'o.mp4', subPath: 'subs.srt', titlePath: "x'y.srt", voicePath: 'v.mp3' })).toThrow();
  });
});

describe('festival music choice', async () => {
  const { musicChoice, pickMusic } = await import('../src/utils/shortSpec.js');
  const set = { url: 'https://a.example/1.mp3 | One\nhttps://a.example/2.mp3 | Two' };
  it('random keeps your music as set', () => {
    expect(musicChoice(set, 'random')).toEqual(set);
    expect(musicChoice(set, '')).toEqual(set);
  });
  it('none is the voice only', () => {
    expect(pickMusic(musicChoice(set, 'none'))).toEqual({});
  });
  it('one track plays with its own credit', () => {
    const m = pickMusic(musicChoice(set, 'https://a.example/2.mp3', 'Two'));
    expect(m.url).toBe('https://a.example/2.mp3');
    expect(m.credits).toEqual({ 'https://a.example/2.mp3': 'Two' });
  });
});

describe('music volume per funnel', async () => {
  const { musicVolumePct, imageShortArgs } = await import('../src/utils/shortSpec.js');
  const filter = (v) => imageShortArgs({ imagePath: 'a.png', outPath: 'o.mp4', voicePath: 'v.mp3', music: { file: 'm.mp3' }, musicVolume: v }).join(' ');
  it('defaults to 20% and never goes over 25%', () => {
    expect(musicVolumePct('')).toBe(20);
    expect(musicVolumePct(undefined)).toBe(20);
    expect(musicVolumePct('80')).toBe(25);
    expect(musicVolumePct('-5')).toBe(0);
    expect(musicVolumePct('10')).toBe(10);
  });
  it('reaches ffmpeg as the funnel set it', () => {
    expect(filter('10')).toContain('volume=0.10,');
    expect(filter('0')).toContain('volume=0.00,');
    expect(filter(undefined)).toContain('volume=0.20,');
    expect(filter('60')).toContain('volume=0.25,');
  });
});

describe('music credits: the whole .txt, its lines kept', async () => {
  const { musicEntries, musicChoice, pickMusic } = await import('../src/utils/shortSpec.js');
  const long = 'Song: Embrace\\nComposer: Sappheiros\\n' + 'x'.repeat(400);
  it('keeps every line and every character', () => {
    const [e] = musicEntries(`https://a.example/1.mp3 | ${long}`);
    expect(e.credit.split('\n')).toEqual(['Song: Embrace', 'Composer: Sappheiros', 'x'.repeat(400)]);
  });
  it('a picked track keeps its lines too', () => {
    const m = pickMusic(musicChoice({}, 'https://a.example/1.mp3', 'Song: Embrace\nComposer: Sappheiros'));
    expect(m.credits['https://a.example/1.mp3']).toBe('Song: Embrace\nComposer: Sappheiros');
  });
});
