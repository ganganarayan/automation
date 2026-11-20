import { describe, it, expect } from 'vitest';
import { textBlock, textLayer } from '../src/utils/thumbSpec.js';
import { lastResort } from '../src/services/textPlaceService.js';

const box = { x0: 100, y0: 100, x1: 700, y1: 400 };

describe('grey panel when no calm area is free', () => {
  it('draws a see-through grey panel and white letters, even when dark was asked', () => {
    const svg = textBlock({ box, text: 'Your Jaw Is Telling You Something', sub: 'Small body signals', maxSize: 80, color: 'dark', panel: true });
    expect(svg).toMatch(/<rect[^>]*fill="#2B2B2B"[^>]*fill-opacity="0.72"/);
    expect(svg).not.toMatch(/fill="#111111"/);
  });
  it('no panel on a calm area the picture offered', () => {
    expect(textBlock({ box, text: 'Hi', maxSize: 80 })).not.toMatch(/<rect/);
  });
  it('the panel is not measured as letters', () => {
    expect(textLayer({ w: 1080, h: 1350, text: 'Hi', place: { ...box, panel: true } }).svg).not.toMatch(/<rect/);
  });
  it('every last-resort place carries the panel', () => {
    const faces = [{ x0: 0, y0: 0, x1: 1080, y1: 1350 }];
    expect(lastResort(null, { w: 1080, h: 1350, bottomClear: 0.4, faces }).panel).toBe(true);
    expect(lastResort(null, { w: 1080, h: 1350, bottomClear: 0.4, faces: [{ x0: 400, y0: 100, x1: 700, y1: 400 }] }).panel).toBe(true);
  });
});
