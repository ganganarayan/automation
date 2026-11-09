import { describe, it, expect } from 'vitest';
import { splitResult, splitUser, NO_TEXT_PICTURE } from '../src/utils/imageSplitSpec.js';
import { placeFor, placeSystem } from '../src/utils/thumbPlaceSpec.js';

describe('sheet prompt split into picture and words', () => {
  it("the sheet's own words win over Claude's copy, and the picture says no text", () => {
    const s = splitResult({ picture: 'A mother on the right, empty sky on the left', headline: 'He just tolerate', sub: 'x', tag: 'y' }, { headline: 'He just tolerates', subhead: 'Read the signs', callout: 'For NRI parents' });
    expect(s.headline).toBe('He just tolerates');
    expect(s.sub).toBe('Read the signs');
    expect(s.tag).toBe('For NRI parents');
    expect(s.picture).toContain('empty sky on the left');
    expect(s.picture).toContain(NO_TEXT_PICTURE);
  });

  it("with no words in the sheet, Claude's are used; no picture or no headline = one-step drawing", () => {
    expect(splitResult({ picture: 'p', headline: 'Stop guessing', sub: 's', tag: 'For founders' }, {})).toMatchObject({ headline: 'Stop guessing', sub: 's', tag: 'For founders' });
    expect(splitResult({ picture: '', headline: 'h', sub: '', tag: '' }, {})).toBeNull();
    expect(splitResult({ picture: 'p', headline: '', sub: '', tag: '' }, {})).toBeNull();
    expect(splitResult(null, {})).toBeNull();
  });

  it('the brief and the sheet words both reach Claude', () => {
    const u = splitUser('Draw a father. HEADLINE (render exactly and verbatim): "Hi"', { headline: 'Hi' });
    expect(u).toContain('<brief>');
    expect(u).toContain('HEADLINE: "Hi"');
  });
});

describe('subtitle band kept clear', () => {
  it('a box running into the bottom quarter is cut above it, or refused when too little is left', () => {
    const size = { w: 1080, h: 1920, bottomClear: 0.25 };
    const subject = { x: 0, y: 0, w: 100, h: 30 };
    const p = placeFor({ subject, text: { x: 5, y: 40, w: 90, h: 50 }, align: 'center', color: 'light' }, size);
    expect(p.y1).toBe(1440);
    expect(placeFor({ subject, text: { x: 5, y: 72, w: 90, h: 25 }, align: 'center', color: 'light' }, size)).toBeNull();
    expect(placeSystem({ bottomClear: 0.25 })).toContain('bottom 25%');
    expect(placeSystem()).not.toContain('subtitles');
  });
});
