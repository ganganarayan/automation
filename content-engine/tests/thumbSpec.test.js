import { describe, it, expect } from 'vitest';
import { THUMB_SIZES, PLATFORM_SIZE, THUMB_SPECS, wrapText, fitText, thumbSvg, thumbImagePrompt, thumbMedia } from '../src/utils/thumbSpec.js';
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
  it('image prompt forbids text in the artwork', () => {
    expect(thumbImagePrompt('A lotus at dawn')).toMatch(/^A lotus at dawn[\s\S]*square[\s\S]*no text/i);
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
      expect(svg).toContain('problem again');
    }
  });
  it('fitText picks the biggest font that keeps every word in the box', () => {
    const f = fitText(long, { boxW: 1100, boxH: 300, maxSize: 200 });
    expect(f.lines.join(' ')).toBe(long);
    expect(f.size * 1.15 * f.lines.length).toBeLessThanOrEqual(300);
    expect(fitText('', { boxW: 100, boxH: 100, maxSize: 50 })).toEqual({ lines: [], size: 0 });
  });
  it('puts the sub-head on a solid accent box with dark text', () => {
    const svg = thumbSvg({ ...THUMB_SIZES.landscape, accent: '#FFC400', text: 'Hi', sub: 'Read me' });
    expect(svg).toMatch(/<rect [^>]*fill="#FFC400"/);
    expect(svg).toContain('fill="#111111"');
  });
});
