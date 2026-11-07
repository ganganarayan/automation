import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { THUMB_SIZES, THUMB_ACCENT, thumbArt, thumbSvg, thumbTagClean, thumbTagFor, thumbTagBox } from '../src/utils/thumbSpec.js';
import { copySystemPrompt, keepThumbTag, normalizeCopy } from '../src/utils/aiCopySpec.js';
import { copyFromCaption } from '../src/utils/routerSpec.js';
import { WIZARD_STEPS } from '../src/services/videoWizardManifest.js';

const LONGEST = 'For early stage founders'; // 24 characters
const CAP = 0.714; // cap height of the bold sans, in em

describe('thumbTagClean', () => {
  it('keeps a good tag', () => {
    expect(thumbTagClean('For founders')).toBe('For founders');
    expect(thumbTagClean('  For   GCC\nleaders ')).toBe('For GCC leaders');
    expect(thumbTagClean(LONGEST)).toBe(LONGEST);
    expect(thumbTagClean('संस्थापकों के लिए')).toBe('संस्थापकों के लिए');
  });
  it.each([
    ['empty', ''],
    ['null', null],
    ['one word', 'Founders'],
    ['five words', 'For the very best founders'],
    ['25 characters', 'For early stage founderss'],
    ['hashtag', 'For #founders'],
    ['emoji', 'For founders 🚀'],
    ['flag', 'For 🇮🇳 founders'],
    ['full stop', 'For founders.'],
    ['exclamation', 'For founders!'],
    ['colon', 'For founders:'],
    ['closing quote', '"For founders"'],
    ['danda', 'संस्थापकों के लिए।'],
  ])('refuses %s', (_, raw) => {
    expect(thumbTagClean(raw)).toBe('');
  });
});

describe('thumbTagFor', () => {
  it('goes tag, then the funnel default, then nothing', () => {
    expect(thumbTagFor({ tag: 'For founders', fallback: 'For coaches' })).toBe('For founders');
    expect(thumbTagFor({ tag: 'bad!', fallback: 'For coaches' })).toBe('For coaches');
    expect(thumbTagFor({ fallback: 'For coaches' })).toBe('For coaches');
    expect(thumbTagFor({ tag: '', fallback: 'nope' })).toBe('');
    expect(thumbTagFor()).toBe('');
  });
  it('off gives nothing, whatever is set', () => {
    expect(thumbTagFor({ on: false, tag: 'For founders', fallback: 'For coaches' })).toBe('');
  });
});

describe('copy carries thumbTag', () => {
  it('is in the fixed part of the prompt, so a saved custom prompt still asks for it', () => {
    const p = copySystemPrompt({ base: 'House voice only.' });
    expect(p).toContain('"thumbTag"');
    expect(p).toMatch(/2 to 4 words/);
  });
  it('normalizeCopy validates it and takes snake_case', () => {
    expect(normalizeCopy({ thumbTag: 'For founders' }).thumbTag).toBe('For founders');
    expect(normalizeCopy({ thumb_tag: 'For coaches' }).thumbTag).toBe('For coaches');
    expect(normalizeCopy({ thumbTag: 'For founders!!' }).thumbTag).toBe('');
  });
  it('an old record with no tag normalises without trouble', () => {
    expect(normalizeCopy({ title: 'Old' }).thumbTag).toBe('');
    expect(normalizeCopy(null).thumbTag).toBe('');
    expect(copyFromCaption('Hello').thumbTag).toBe('');
  });
  it('a page save keeps the stored tag; the page sends only four fields', () => {
    const fromPage = normalizeCopy({ title: 't', description: 'd', igCaption: 'i', short: 's' });
    expect(keepThumbTag(fromPage, { thumbTag: 'For founders' }).thumbTag).toBe('For founders');
    expect(keepThumbTag(fromPage, {}).thumbTag).toBe('');
    expect(keepThumbTag(fromPage, undefined).thumbTag).toBe('');
    expect(keepThumbTag({ title: 't', thumbTag: 'For coaches' }, { thumbTag: 'For founders' }).thumbTag).toBe('For coaches');
  });
});

describe('the settings', () => {
  it('Lane 1 has the switch and the funnel default', () => {
    const keys = WIZARD_STEPS.find((s) => s.id === 'ready').fields.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['thumb_tag', 'thumb_tag_default']));
  });
});

describe('the pill in each size', () => {
  const sizes = Object.entries(THUMB_SIZES);

  it.each(sizes)('%s: stays inside the left 55%, the picture and the frame, at any allowed length', (_, spec) => {
    for (const tag of ['For you', 'For founders', LONGEST, 'WWWW WWWW WWWW WWWW WWWW'.slice(0, 24)]) {
      const b = thumbTagBox({ ...spec, tag });
      expect(b.x).toBe(Math.round(spec.w * 0.05));
      expect(b.x + b.w).toBeLessThanOrEqual(Math.round(spec.w * 0.55));
      const art = thumbArt(spec);
      expect(b.y).toBeGreaterThanOrEqual(art ? art.top : Math.round(spec.h * 0.34)); // clear of the headline and its haze
      expect(b.y + b.h).toBeLessThanOrEqual(art ? art.top + art.h : spec.h);
    }
  });

  it('sits at the bottom of the picture, not of the frame, in 9:16', () => {
    const spec = THUMB_SIZES.portrait;
    const art = thumbArt(spec);
    const b = thumbTagBox({ ...spec, tag: 'For founders' });
    expect(b.y + b.h).toBe(art.top + art.h - Math.round(spec.h * 0.04));
    expect(b.y + b.h).toBeLessThan(spec.h * 0.875); // inside the centre 3:4 Instagram's grid shows
  });

  it.each(sizes)('%s: caps stay at least 3.2px tall when shown 160px wide, even at 24 characters', (_, spec) => {
    const b = thumbTagBox({ ...spec, tag: LONGEST });
    expect((b.size * CAP * 160) / spec.w).toBeGreaterThanOrEqual(3.2);
  });

  it.each(sizes)('%s: is smaller than the headline at its normal size', (_, spec) => {
    const svg = thumbSvg({ ...spec, text: 'Why your best leads never reply', tag: 'For founders' });
    const [head, tag] = [...svg.matchAll(/font-size="(\d+)"/g)].map((m) => Number(m[1]));
    expect(tag).toBeLessThan(head * 0.7);
  });

  it('draws black capitals on the accent, escaped', () => {
    const svg = thumbSvg({ ...THUMB_SIZES.landscape, text: 'Hook', tag: 'For R&D leads' });
    expect(svg).toContain(`fill="${THUMB_ACCENT}"`);
    expect(svg).toContain('fill="#000000">FOR R&amp;D LEADS</text>');
  });

  it('no tag leaves the SVG as it was before this feature', () => {
    const args = { ...THUMB_SIZES.landscape, accent: THUMB_ACCENT, text: 'Hook line', sub: 'Sub' };
    expect(thumbSvg({ ...args, tag: '' })).toBe(thumbSvg(args));
    expect(thumbSvg(args)).not.toContain('text-anchor="middle" font-family="Noto Sans, Noto Sans Devanagari, DejaVu Sans, sans-serif" font-weight="800" font-size="40"');
    expect(thumbSvg(args).match(/<rect/g)).toHaveLength(1); // the haze only
  });

  it.each(sizes)('%s: renders, and at 160px wide the pill still stands out as solid accent and dark text', async (_, spec) => {
    const svg = thumbSvg({ ...spec, accent: THUMB_ACCENT, text: 'Why your best leads never reply', tag: LONGEST });
    const full = await sharp({ create: { width: spec.w, height: spec.h, channels: 3, background: '#3060A0' } })
      .composite([{ input: Buffer.from(svg) }]).png().toBuffer();
    const scale = 160 / spec.w;
    const { data, info } = await sharp(full).resize(160).raw().toBuffer({ resolveWithObject: true });
    const b = thumbTagBox({ ...spec, tag: LONGEST });
    let accent = 0;
    let dark = 0;
    const y0 = Math.ceil(b.y * scale);
    const y1 = Math.floor((b.y + b.h) * scale);
    const x0 = Math.ceil(b.x * scale);
    const x1 = Math.floor((b.x + b.w) * scale);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * info.width + x) * info.channels;
        const [r, g, bl] = [data[i], data[i + 1], data[i + 2]];
        if (r > 200 && g > 150 && bl < 90) accent += 1;
        if (r < 150 && g < 120) dark += 1;
      }
    }
    expect(accent).toBeGreaterThan(0);
    expect(dark).toBeGreaterThan(0); // the letters survive the downscale instead of blurring into the pill
  });
});
