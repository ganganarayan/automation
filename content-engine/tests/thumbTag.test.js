import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { THUMB_SIZES, THUMB_ACCENT, thumbArt, thumbSvg, thumbTagClean, thumbTagFor, thumbTagBox } from '../src/utils/thumbSpec.js';
import { copySystemPrompt, keepHiddenCopy, nextImagePrompt, normalizeCopy } from '../src/utils/aiCopySpec.js';
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
    expect(p).toMatch(/2 to 6 words/);
  });
  it('normalizeCopy validates it and takes snake_case', () => {
    expect(normalizeCopy({ thumbTag: 'For founders' }).thumbTag).toBe('For founders');
    expect(normalizeCopy({ thumb_tag: 'For coaches' }).thumbTag).toBe('For coaches');
    expect(normalizeCopy({ thumbTag: 'For founders!!' }).thumbTag).toBe('For founders');
    expect(normalizeCopy({ thumbTag: '#founders' }).thumbTag).toBe('');
  });
  it('an old record with no tag normalises without trouble', () => {
    expect(normalizeCopy({ title: 'Old' }).thumbTag).toBe('');
    expect(normalizeCopy(null).thumbTag).toBe('');
    expect(copyFromCaption('Hello').thumbTag).toBe('');
  });
  it('a page save keeps the stored tag; the page sends only four fields', () => {
    const fromPage = normalizeCopy({ title: 't', description: 'd', igCaption: 'i', short: 's' });
    expect(keepHiddenCopy(fromPage, { thumbTag: 'For founders' }).thumbTag).toBe('For founders');
    expect(keepHiddenCopy(fromPage, {}).thumbTag).toBe('');
    expect(keepHiddenCopy(fromPage, undefined).thumbTag).toBe('');
    expect(keepHiddenCopy({ title: 't', thumbTag: 'For coaches' }, { thumbTag: 'For founders' }).thumbTag).toBe('For coaches');
  });
});

describe('a page save keeps what the page does not show', () => {
  const fromPage = normalizeCopy({ title: 't', description: 'd', igCaption: 'i', short: 's' });
  const stored = { thumbText: 'The hook', thumbTag: 'For founders', thumbPrompt: 'A falling chart' };

  it('keeps the hook and the image prompt, and leaves the shown fields alone', () => {
    expect(keepHiddenCopy(fromPage, stored)).toEqual({ title: 't', description: 'd', igCaption: 'i', short: 's', thumbSub: '', ...stored });
  });
  it('a new value wins over the stored one', () => {
    const c = keepHiddenCopy({ ...fromPage, thumbText: 'New hook', thumbPrompt: 'New chart' }, stored);
    expect(c.thumbText).toBe('New hook');
    expect(c.thumbPrompt).toBe('New chart');
  });
  it('an old record with none of them stays blank', () => {
    for (const old of [undefined, null, {}]) {
      const c = keepHiddenCopy(fromPage, old);
      expect([c.thumbText, c.thumbTag, c.thumbPrompt]).toEqual(['', '', '']);
    }
  });
  it('after a save, the writer\'s image prompt still follows new copy', () => {
    const saved = keepHiddenCopy(fromPage, stored);
    expect(nextImagePrompt('A falling chart', fromPage.thumbPrompt, 'A new chart')).toBe('A falling chart'); // the old bug
    expect(nextImagePrompt('A falling chart', saved.thumbPrompt, 'A new chart')).toBe('A new chart');
    expect(nextImagePrompt('My own prompt', saved.thumbPrompt, 'A new chart')).toBe('My own prompt');
  });
});

describe('the settings', () => {
  it('Lane 1 has the switch and the funnel default', () => {
    const keys = WIZARD_STEPS.find((s) => s.id === 'ready').fields.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['thumb_tag', 'thumb_tag_default']));
  });
});

describe('the audience line above the headline', () => {
  it.each(Object.entries(THUMB_SIZES))('%s: smaller than the headline, above it, accent serif capitals', (_, spec) => {
    const svg = thumbSvg({ ...spec, accent: THUMB_ACCENT, text: 'He just tolerates', tag: 'For NRI parents' });
    const brow = svg.match(/<text x="\d+" y="(\d+)"[^>]*Noto Serif[^>]*font-size="(\d+)" fill="([^"]+)"[^>]*>FOR NRI PARENTS</);
    const head = svg.match(/font-weight="800" font-size="(\d+)"[^>]*><tspan x="\d+" y="(\d+)"/);
    expect(brow).not.toBeNull();
    expect(Number(brow[2])).toBeLessThan(Number(head[1]) * 0.5);
    expect(Number(brow[1])).toBeLessThan(Number(head[2]));
    expect(brow[3]).toBe(THUMB_ACCENT);
  });
  it('a hashtag or an over-long line is not drawn; escaped', () => {
    expect(thumbSvg({ ...THUMB_SIZES.landscape, text: 'x', tag: '#parents' })).not.toContain('Noto Serif');
    expect(thumbSvg({ ...THUMB_SIZES.landscape, text: 'x', tag: 'For parents of teenagers in every single city' })).not.toContain('Noto Serif');
    expect(thumbSvg({ ...THUMB_SIZES.landscape, text: 'x', tag: 'For R&D leads' })).toContain('FOR R&amp;D LEADS');
  });
});
