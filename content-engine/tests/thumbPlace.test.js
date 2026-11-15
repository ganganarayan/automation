import { describe, it, expect } from 'vitest';
import { placeFor, placeWhyNot, placeUser, overlapShare, PLACE_SCHEMA } from '../src/utils/thumbPlaceSpec.js';
import sharp from 'sharp';
import { placeText, placeNoteText } from '../src/services/textPlaceService.js';
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

  it('a box on the face is moved beside the subject, never left on it', () => {
    const subject = { x: 30, y: 0, w: 40, h: 100 };
    const p = placeFor({ subject, text: { x: 20, y: 5, w: 60, h: 30 }, align: 'center', color: 'light' }, land);
    expect(p).not.toBeNull();
    expect(p.how).toBe('beside');
    expect(overlapShare(p, { x0: 384, y0: 0, x1: 896, y1: 720 })).toBe(0);
    expect(p.x1 - p.x0).toBeGreaterThanOrEqual(1280 * 0.22);
  });

  it('nothing usable is refused: no answer, no subject and a bad box, or a subject filling the frame', () => {
    expect(placeFor(null, land)).toBeNull();
    expect(placeFor({ text: { x: 'a', y: 0, w: 1, h: 1 } }, land)).toBeNull();
    expect(placeFor({ subject: { x: 10, y: 5, w: 80, h: 90 }, text: { x: 20, y: 5, w: 60, h: 30 } }, land)).toBeNull();
    expect(placeWhyNot(null, land)).toMatch(/no text box/);
    expect(placeWhyNot({ subject: { x: 10, y: 5, w: 80, h: 90 } }, land)).toMatch(/fills the picture/);
  });

  it('prod 15-11-2026: text box right of a man whose subject box ends at 70% is trimmed, not dropped to the top band', () => {
    // The exact answer Claude gave for instance 1a94ced2 (landscape), refused before this fix.
    const raw = { align: 'left', color: 'light', size: 'landscape', subject: { h: 98, w: 70, x: 0, y: 2 }, text: { h: 60, w: 33, x: 64, y: 8 } };
    const p = placeFor(raw, land);
    expect(p).toMatchObject({ how: 'trimmed', align: 'left', color: 'light' });
    expect(p.x0).toBeGreaterThanOrEqual(Math.round(1280 * 0.7));
    expect(p.x1).toBe(Math.round(1280 * 0.97));
    expect(p.y0).toBe(Math.round(720 * 0.08));
    expect(p.y1).toBe(Math.round(720 * 0.68));
  });

  it('a box already clear of the subject is kept as picked', () => {
    const p = placeFor({ subject: { x: 0, y: 0, w: 50, h: 100 }, text: { x: 55, y: 10, w: 40, h: 50 }, align: 'right', color: 'dark' }, land);
    expect(p.how).toBe('picked');
  });

  it('a tiny box with room beside the subject uses the widest free strip', () => {
    const p = placeFor({ subject: { x: 0, y: 0, w: 55, h: 100 }, text: { x: 60, y: 5, w: 10, h: 10 }, align: 'left', color: 'light' }, land);
    expect(p.how).toBe('beside');
    expect(p.x0).toBeGreaterThan(1280 * 0.55);
  });

  it('a strip beside the subject keeps the subtitle band clear', () => {
    const p = placeFor({ subject: { x: 0, y: 0, w: 55, h: 100 }, text: { x: 0, y: 0, w: 1, h: 1 } }, { ...land, bottomClear: 0.25 });
    expect(p.y1).toBeLessThanOrEqual(720 * 0.75);
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

describe('placement never fails silently', () => {
  const pic = async () => ({ buf: await sharp({ create: { width: 320, height: 180, channels: 3, background: '#333' } }).png().toBuffer(), w: 1280, h: 720, label: '16:9' });
  const claude = (data) => ({ generateJsonDetailed: async () => ({ data, model: 'claude-opus-5', usage: { inputTokens: 10, outputTokens: 10 } }) });

  it('the prod answer is placed now, with no note', async () => {
    const notes = [];
    const out = await placeText({ claude: claude({ sizes: [{ size: 'landscape', align: 'left', color: 'light', subject: { x: 0, y: 2, w: 70, h: 98 }, text: { x: 64, y: 8, w: 33, h: 60 } }] }), pictures: { landscape: await pic() }, text: 'THEY WATCH YOU', notes });
    expect(out.landscape.how).toBe('trimmed');
    expect(notes).toEqual([]);
    expect(placeNoteText(notes)).toBe('');
  });

  it('a size with no usable box, a missing size, a failed call and no Claude key each leave a note', async () => {
    const pictures = { landscape: await pic(), feed: { ...(await pic()), w: 1080, h: 1350, label: '4:5' } };
    const notes = [];
    await placeText({ claude: claude({ sizes: [{ size: 'landscape', align: 'left', color: 'light', subject: { x: 5, y: 5, w: 90, h: 90 }, text: { x: 10, y: 10, w: 50, h: 30 } }] }), pictures, text: 'Hi there', notes });
    expect(notes.map((n) => n.label)).toEqual(['16:9', '4:5']);
    expect(placeNoteText(notes)).toMatch(/fixed top band/);
    expect(placeNoteText(notes)).toMatch(/16:9: the subject fills the picture/);

    const failed = [];
    await placeText({ claude: { generateJsonDetailed: async () => { throw new Error('overloaded'); } }, pictures, text: 'Hi', notes: failed });
    expect(failed).toHaveLength(2);
    expect(failed[0].reason).toMatch(/overloaded/);

    const none = [];
    expect(await placeText({ claude: null, pictures, text: 'Hi', notes: none })).toEqual({});
    expect(none[0].reason).toMatch(/no Claude key/);
  });
});
