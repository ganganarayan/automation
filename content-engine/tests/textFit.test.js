import { describe, it, expect } from 'vitest';
import { fitText, textWidthEm, textLayer, wrapText } from '../src/utils/thumbSpec.js';
import { fittedOverlay, shrinkFor, inkBox } from '../src/services/textPlaceService.js';

const HEADLINES = [
  'Still downloading',
  'STILL DOWNLOADING',
  'Live in under 90 seconds instead',
  'WWW MMM WWW',
  'Supercalifragilisticexpialidocious works',
  'Why your course is not selling',
  'नमस्ते दुनिया',
];

describe('letter widths', () => {
  it('wide capitals are measured as wide (the old flat 0.62 was too narrow)', () => {
    expect(textWidthEm('DOWNLOADING')).toBeGreaterThan(11 * 0.62 * 1.1);
    expect(textWidthEm('W')).toBeGreaterThan(textWidthEm('I') * 2.5);
  });
  it('letter spacing adds between letters only', () => {
    expect(textWidthEm('AB', { spacing: 0.1 })).toBeCloseTo(textWidthEm('AB') + 0.1, 5);
  });
});

describe('fitText never splits a word and never overflows', () => {
  for (const text of HEADLINES) {
    for (const boxW of [220, 420, 900]) {
      it(`"${text}" in ${boxW}px`, () => {
        const fit = fitText(text, { boxW, boxH: 300, maxSize: 140 });
        // Every line is whole words, in order: a word is never broken across lines.
        expect(fit.lines.join(' ').split(' ')).toEqual(text.trim().split(/\s+/));
        for (const line of fit.lines) expect(textWidthEm(line) * fit.size + 0.06 * fit.size).toBeLessThanOrEqual(boxW + 0.5);
      });
    }
  }
  it('wrapText keeps a long word whole', () => {
    expect(wrapText('A DOWNLOADING B', 4, 9)).toEqual(['A', 'DOWNLOADING', 'B']);
  });
});

describe('shrinkFor', () => {
  const box = { x0: 100, y0: 100, x1: 500, y1: 300 };
  it('ink inside the box needs no shrink', () => {
    expect(shrinkFor({ x0: 120, y0: 120, x1: 480, y1: 280 }, box, 1280, 720)).toBe(1);
  });
  it('ink past the right edge shrinks by about the overflow', () => {
    const k = shrinkFor({ x0: 100, y0: 120, x1: 600, y1: 280 }, box, 1280, 720);
    expect(k).toBeLessThan(0.81);
    expect(k).toBeGreaterThan(0.7);
  });
  it('no ink, nothing to do', () => {
    expect(shrinkFor(null, box, 1280, 720)).toBe(1);
  });
});

describe('the drawn letters stay in their box (real render)', () => {
  // The screenshot case: a narrow box on the right of a 16:9 thumbnail.
  const place = { x0: 820, y0: 80, x1: 1240, y1: 400, align: 'left', color: 'light' };
  for (const text of ['STILL DOWNLOADING', 'Still downloading', 'WWW MMM WWW']) {
    it(`"${text}" placed`, async () => {
      const svg = await fittedOverlay({ w: 1280, h: 720, text, sub: 'Live in under 90 seconds instead', tag: 'For course creators', place });
      const ink = await inkBox(svg);
      const tol = 3;
      expect(ink.x0).toBeGreaterThanOrEqual(place.x0 - tol);
      expect(ink.x1).toBeLessThanOrEqual(place.x1 + tol);
      expect(ink.y1).toBeLessThanOrEqual(place.y1 + tol);
    }, 30000);
  }
  it('fixed layout stays inside its band', async () => {
    const svg = await fittedOverlay({ w: 1080, h: 1350, layout: 'stack', text: 'STILL DOWNLOADING EVERY WEEKEND' });
    const { box } = textLayer({ w: 1080, h: 1350, layout: 'stack', text: 'x' });
    // Measure only the text: the fixed layout also draws a haze behind it.
    const ink = await inkBox(textLayer({ w: 1080, h: 1350, layout: 'stack', text: 'STILL DOWNLOADING EVERY WEEKEND' }).svg);
    expect(svg).toContain('<text');
    expect(ink.x1 - ink.x0).toBeLessThanOrEqual(box.x1 - box.x0 + 6);
  }, 30000);
});
