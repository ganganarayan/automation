import { describe, it, expect } from 'vitest';
import { placeFor, placeUser, overlapShare, PLACE_SCHEMA } from '../src/utils/thumbPlaceSpec.js';
import { thumbSvgPlaced, THUMB_SIZES, thumbImagePrompt } from '../src/utils/thumbSpec.js';

const land = THUMB_SIZES.landscape;

describe('text box picked from the picture', () => {
  it('a box clear of the subject is kept, in pixels, inside the edges', () => {
    const p = placeFor({ size: 'landscape', subject: { x: 55, y: 5, w: 45, h: 95 }, text: { x: 0, y: 10, w: 50, h: 60 }, align: 'left', color: 'light' }, land);
    expect(p).toMatchObject({ align: 'left', color: 'light' });
    expect(p.x0).toBe(Math.round(1280 * 0.03));
    expect(p.x1).toBe(640);
    expect(p.y0).toBe(72);
  });

  it('a box on the face, a tiny box or nothing is refused', () => {
    const subject = { x: 30, y: 0, w: 40, h: 100 };
    expect(placeFor({ subject, text: { x: 20, y: 5, w: 60, h: 30 }, align: 'center', color: 'light' }, land)).toBeNull();
    expect(placeFor({ subject, text: { x: 0, y: 0, w: 10, h: 10 }, align: 'left', color: 'light' }, land)).toBeNull();
    expect(placeFor(null, land)).toBeNull();
    expect(placeFor({ subject, text: { x: 'a', y: 0, w: 1, h: 1 } }, land)).toBeNull();
  });

  it('odd align or colour falls back to centred light text', () => {
    const p = placeFor({ subject: { x: 0, y: 70, w: 100, h: 30 }, text: { x: 5, y: 5, w: 90, h: 40 }, align: 'diagonal', color: 'red' }, land);
    expect(p).toMatchObject({ align: 'center', color: 'light' });
  });

  it('overlap is the share of the text box on the subject', () => {
    expect(overlapShare({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 0, x1: 20, y1: 10 })).toBe(0.5);
    expect(overlapShare({ x0: 0, y0: 0, x1: 10, y1: 10 }, null)).toBe(0);
  });

  it('every size is sent as an image with its name, after the words', () => {
    const blocks = placeUser([{ size: 'landscape', label: '16:9', w: 1280, h: 720, b64: 'AAA' }], { text: 'He just tolerates', tag: 'For NRI parents' });
    expect(blocks[0].text).toContain('He just tolerates');
    expect(blocks[0].text).toContain('For NRI parents');
    expect(blocks[2]).toMatchObject({ type: 'image', source: { media_type: 'image/jpeg', data: 'AAA' } });
    expect(PLACE_SCHEMA.required).toEqual(['sizes']);
  });
});

describe('the text drawn in that box', () => {
  it('right-aligned dark text ends on the box edge, the pill stays in the frame', () => {
    const svg = thumbSvgPlaced({ ...land, text: 'He just tolerates', tag: 'For NRI parents', place: { x0: 700, y0: 400, x1: 1240, y1: 690, align: 'right', color: 'dark' } });
    expect(svg).toContain('text-anchor="end"');
    expect(svg).toContain('x="1240"');
    expect(svg).toContain('fill="#111111"');
    expect(svg).toContain('FOR NRI PARENTS');
    expect(svg.indexOf('FOR NRI PARENTS')).toBeLessThan(svg.indexOf('He just'));
  });

  it('Claude-written prompts ask for an empty area and no text', () => {
    const p = thumbImagePrompt('A father on the right, empty wall on the left', '', 'x', { asWritten: true });
    expect(p).toMatch(/empty area/);
    expect(p).toMatch(/No text/);
    expect(p).not.toMatch(/top 30%/);
  });
});
