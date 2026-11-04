import { sheetThumbPrompt } from '../src/utils/postCompose.js';
import { describe, it, expect } from 'vitest';
import { nativeArtSize, THUMB_SIZES, PLATFORM_SIZE, THUMB_SPECS, wrapText, fitText, thumbBox, thumbArt, thumbSvg, thumbImagePrompt, DEFAULT_THUMB_RULES, thumbMedia } from '../src/utils/thumbSpec.js';
import { platformConfigsFor } from '../src/utils/aiCopySpec.js';

describe('thumbSpec', () => {
  it('has a size + layout for every platform', () => {
    for (const k of ['youtube', 'facebook', 'linkedin', 'x', 'instagram', 'threads']) {
      expect(THUMB_SPECS[k].w).toBeGreaterThan(0);
      expect(THUMB_SPECS[k].h).toBeGreaterThan(0);
    }
    expect(THUMB_SPECS.instagram.h).toBeGreaterThan(THUMB_SPECS.instagram.w);
    expect(THUMB_SPECS.youtube.w).toBeGreaterThan(THUMB_SPECS.youtube.h);
  });
  it('renders three sizes, each platform mapped to one', () => {
    expect(Object.values(THUMB_SIZES).map((z) => `${z.w}x${z.h}`)).toEqual(['1280x720', '1080x1920', '1080x1350']);
    expect(new Set(Object.values(PLATFORM_SIZE))).toEqual(new Set(Object.keys(THUMB_SIZES)));
    expect(THUMB_SPECS.youtube).toMatchObject({ w: 1280, h: 720, size: 'landscape' });
    expect(PLATFORM_SIZE.tiktok).toBeUndefined();
  });
  it('wraps text and clips past the line limit', () => {
    expect(wrapText('Why Krishna Smiled At Arjuna', 16, 3)).toEqual(['Why Krishna', 'Smiled At Arjuna']);
    expect(wrapText('a b c d e f g h', 1, 2)).toEqual(['a', 'b…']);
    expect(wrapText('', 10, 3)).toEqual([]);
  });
  it('builds an escaped SVG at the spec size', () => {
    const svg = thumbSvg({ ...THUMB_SPECS.youtube, text: 'Fear & <Faith>' });
    expect(svg).toContain('width="1280" height="720"');
    expect(svg).toContain('Fear &amp;');
    expect(svg).toContain('&lt;Faith&gt;');
  });
  it('the image prompt keeps the headline out of the picture, but tells the model what it must prove', () => {
    const p = thumbImagePrompt('A retention chart', '', 'Where Your VSL Leaks');
    expect(p).toMatch(/^A retention chart/);
    expect(p).toContain('headline going over this image is "Where Your VSL Leaks"');
    expect(p).toContain('Do not write the headline');
    expect(thumbImagePrompt('x')).not.toContain('headline going over');
  });
  it('asks for a clear picture with room for the headline on top, never the old dark split', () => {
    expect(DEFAULT_THUMB_RULES).toMatch(/top 30%/);
    expect(DEFAULT_THUMB_RULES).toMatch(/No silhouettes, no dark moody scene/);
    expect(DEFAULT_THUMB_RULES).not.toMatch(/LEFT|RIGHT|cinematic/);
  });
  it('your own Settings rules win; the old default saved in Settings does not', () => {
    expect(thumbImagePrompt('x', 'My rules')).toBe('x\n\nMy rules');
    const old = 'Thumbnail artwork, square composition. Show only what is described above: no person or face unless it asks for one. Place the main subject on the LEFT side of the frame (the left 55%), whole and well lit, with room around it. Keep the RIGHT 45% of the frame calm and empty: a plain dark wall, a soft out-of-focus background or sky, nothing important there, so a headline can sit on it. Bold cinematic lighting, high contrast, one clear focal subject. Absolutely no text, letters, words, captions, logos or watermarks.';
    expect(thumbImagePrompt('x', old)).toBe(`x\n\n${DEFAULT_THUMB_RULES}`);
  });
  it('media item: designed thumbnail, else the first frame', () => {
    expect(thumbMedia('https://v', 'https://t')).toEqual({ url: 'https://v', thumbnail_url: 'https://t' });
    expect(thumbMedia('https://v', '')).toEqual({ url: 'https://v', thumbnail_timestamp_ms: 0 });
  });
  it('platformConfigsFor puts each platform its own thumbnail', () => {
    const accountMap = { a: { platform: 'YouTube' }, b: { platform: 'Instagram' } };
    const { platformConfigurations: pc } = platformConfigsFor({ title: 'T', description: 'D', igCaption: 'I', short: 'S' },
      { accountIds: ['a', 'b'], accountMap, videoUrl: 'https://v', thumbs: { youtube: 'https://yt.jpg' } });
    expect(pc.youtube.media).toEqual([{ url: 'https://v', thumbnail_url: 'https://yt.jpg' }]);
    expect(pc.instagram.media).toEqual([{ url: 'https://v', thumbnail_timestamp_ms: 0 }]);
  });
});

describe('thumbSvg sub-head', () => {
  it('draws the sub-head under the headline in the accent colour', () => {
    const svg = thumbSvg({ ...THUMB_SPECS.youtube, text: 'Why STHIRA works', sub: 'The combat engine, repaired' });
    expect(svg).toContain('The combat engine');
    expect(svg).toContain(`fill="${THUMB_SPECS.youtube.accent}"`);
    expect(thumbSvg({ ...THUMB_SPECS.youtube, text: 'Only headline' })).not.toContain('font-weight="700"');
  });
});

describe('thumbSvg fits the whole headline', () => {
  const long = 'Negative Lead Generation - Less but Qualified Leads Win Every Time';
  it('never cuts the headline or the sub-head', () => {
    for (const spec of Object.values(THUMB_SIZES)) {
      const svg = thumbSvg({ ...spec, accent: '#FFC400', text: long, sub: 'You will never have a disqualified lead problem again' });
      expect(svg).not.toContain('…');
      for (const word of long.split(' ')) expect(svg).toContain(word);
      for (const word of 'You will never have a disqualified lead problem again'.split(' ')) expect(svg).toContain(word);
    }
  });
  it('fitText picks the biggest font that keeps every word in the box', () => {
    const f = fitText(long, { boxW: 1100, boxH: 300, maxSize: 200 });
    expect(f.lines.join(' ')).toBe(long);
    expect(f.size * 1.15 * f.lines.length).toBeLessThanOrEqual(300);
    expect(fitText('', { boxW: 100, boxH: 100, maxSize: 50 })).toEqual({ lines: [], size: 0 });
  });
});

describe('thumbSvg keeps the text on top and the picture prominent', () => {
  const text = 'Internally Exhausted? On the verge of giving up?';
  const sub = 'Holidays, self help & surface level methods could not fix';
  const ys = (svg) => [...svg.matchAll(/<tspan x="\d+" y="(\d+)"/g)].map((m) => Number(m[1]));

  it('every size keeps all its text inside the top 30%, centred', () => {
    for (const spec of Object.values(THUMB_SIZES)) {
      const svg = thumbSvg({ ...spec, text, sub });
      for (const y of ys(svg)) expect(y).toBeLessThanOrEqual(spec.h * 0.3);
      expect(svg).toContain('text-anchor="middle"');
      expect(svg).not.toContain('text-anchor="start"');
    }
  });
  it('16:9 hazes out over the full-frame picture, with no solid patch', () => {
    const svg = thumbSvg({ ...THUMB_SIZES.landscape, text, sub });
    expect(thumbArt(THUMB_SIZES.landscape)).toBeNull();
    expect(svg).toContain('stop-opacity="0"');
    expect(svg).not.toMatch(/stop-opacity="\.[7-9]/);
  });
  it('narrow sizes put the picture on a panel under the text', () => {
    expect(thumbArt(THUMB_SIZES.feed)).toEqual({ top: 378, w: 1080, h: 972 });
    const spec = THUMB_SIZES.portrait;
    const art = thumbArt(spec);
    expect(art).toEqual({ top: 576, w: 1080, h: 960 });
    for (const y of ys(thumbSvg({ ...spec, text, sub }))) expect(y).toBeLessThan(art.top);
    // Inside the centre 3:4 that the Instagram grid shows.
    expect(thumbBox(spec).y0).toBeGreaterThan((1920 - 1440) / 2);
    expect(art.top + art.h).toBeLessThanOrEqual((1920 + 1440) / 2);
  });
});

describe('thumbnails from the content sheet', () => {
  const fields = { imagePrompt: '9:16 graphic of a drop', headline: 'Find the second', subhead: 'Exactly', lockedSpecs: '' };
  it('uses the row word for word, and names the size being made', () => {
    const p = sheetThumbPrompt(fields, '16:9');
    expect(p).toContain('9:16 graphic of a drop');
    expect(p).toContain('HEADLINE (render exactly and verbatim): "Find the second"');
    expect(p).toContain('SUBHEAD (render exactly and verbatim): "Exactly"');
    expect(p).toContain('Format of this version: 16:9');
  });
  it('asks for an image close to each size', () => {
    expect(nativeArtSize(THUMB_SIZES.landscape)).toBe('1536x1024');
    expect(nativeArtSize(THUMB_SIZES.portrait)).toBe('1024x1536');
    expect(nativeArtSize(THUMB_SIZES.feed)).toBe('1024x1536');
  });
});
