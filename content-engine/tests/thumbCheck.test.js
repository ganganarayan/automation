import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { placeChecked, placeNoteText } from '../src/services/textPlaceService.js';
import { CHECK_SCHEMA, checkFor, freeParts, placeFor, overlapShare } from '../src/utils/thumbPlaceSpec.js';

const W = 1280; const H = 720;
const pic = async () => ({ buf: await sharp({ create: { width: W, height: H, channels: 3, background: '#333' } }).png().toBuffer(), w: W, h: H, label: '16:9', layout: 'top' });
const usage = { inputTokens: 10, outputTokens: 10 };

/** A fake Claude: answers placement and check calls from two scripts, and counts them. */
function fakeClaude({ places = [], checks = [] }) {
  const calls = [];
  return {
    calls,
    generateJsonDetailed: async ({ schema }) => {
      const kind = schema === CHECK_SCHEMA ? 'check' : 'place';
      calls.push(kind);
      const next = (kind === 'check' ? checks : places).shift();
      if (next instanceof Error) throw next;
      return { data: next || { sizes: [] }, model: 'claude-opus-5', usage };
    },
  };
}

const face = { x: 40, y: 10, w: 20, h: 35 }; // percent: a face top centre
const facePx = { x0: W * 0.4, y0: H * 0.1, x1: W * 0.6, y1: H * 0.45 };
const topCentre = { size: 'landscape', align: 'center', color: 'light', subject: { x: 0, y: 60, w: 30, h: 40 }, text: { x: 25, y: 5, w: 50, h: 30 } };
const right = { size: 'landscape', align: 'left', color: 'light', subject: { x: 0, y: 0, w: 62, h: 100 }, text: { x: 66, y: 10, w: 30, h: 50 } };
const ok = { sizes: [{ size: 'landscape', ok: true, faces: [face], problem: '' }] };
const onFace = { sizes: [{ size: 'landscape', ok: false, faces: [face], problem: 'the man\'s face' }] };

describe('place, check, at most one more try', () => {
  it('a clean first try costs two calls and leaves no note', async () => {
    const claude = fakeClaude({ places: [{ sizes: [right] }], checks: [ok] });
    const notes = [];
    const places = await placeChecked({ claude, pictures: { landscape: await pic() }, text: 'THEY WATCH YOU', notes });
    expect(claude.calls).toEqual(['place', 'check']);
    expect(places.landscape.how).toBe('picked');
    expect(notes).toEqual([]);
  });

  it('text on a face is placed again clear of that face, and checked once more', async () => {
    const claude = fakeClaude({ places: [{ sizes: [topCentre] }, { sizes: [right] }], checks: [onFace, ok] });
    const notes = [];
    const costs = [];
    const places = await placeChecked({ claude, pictures: { landscape: await pic() }, text: 'THEY WATCH YOU', notes, costs });
    expect(claude.calls).toEqual(['place', 'check', 'place', 'check']);
    expect(overlapShare(places.landscape, facePx)).toBe(0);
    expect(notes).toEqual([]);
    expect(costs).toHaveLength(4);
  });

  it('the second try is clear of the face even when the model points at it again', async () => {
    // Second answer: the same box on the face. The face from the check is kept out regardless.
    const claude = fakeClaude({ places: [{ sizes: [topCentre] }, { sizes: [topCentre] }], checks: [onFace, ok] });
    const places = await placeChecked({ claude, pictures: { landscape: await pic() }, text: 'THEY WATCH YOU', notes: [] });
    expect(places.landscape).not.toBeNull();
    expect(overlapShare(places.landscape, facePx)).toBe(0);
  });

  it('a check that always says no stops after four calls: moved clear of every face, with a note', async () => {
    const face2 = { x: 70, y: 10, w: 15, h: 30 };
    const always = { sizes: [{ size: 'landscape', ok: false, faces: [face, face2], problem: 'a face' }] };
    const claude = fakeClaude({ places: [{ sizes: [topCentre] }, { sizes: [right] }, { sizes: [right] }], checks: [onFace, always, always, always] });
    const notes = [];
    const places = await placeChecked({ claude, pictures: { landscape: await pic() }, text: 'THEY WATCH YOU', notes });
    expect(claude.calls).toHaveLength(4);
    expect(overlapShare(places.landscape, facePx)).toBe(0);
    expect(overlapShare(places.landscape, { x0: W * 0.7, y0: H * 0.1, x1: W * 0.85, y1: H * 0.4 })).toBe(0);
    expect(placeNoteText(notes)).toMatch(/not checked a third time/);
  });

  it('faces filling the picture: no text at all, never text on a face, and said on the page', async () => {
    const full = { sizes: [{ size: 'landscape', ok: false, faces: [{ x: 0, y: 0, w: 100, h: 100 }], problem: 'faces everywhere' }] };
    const claude = fakeClaude({ places: [{ sizes: [topCentre] }, { sizes: [topCentre] }], checks: [full] });
    const notes = [];
    const places = await placeChecked({ claude, pictures: { landscape: await pic() }, text: 'THEY WATCH YOU', notes });
    expect(places.landscape).toEqual({ none: true });
    expect(claude.calls).toEqual(['place', 'check', 'place']);
    expect(placeNoteText(notes)).toMatch(/no text on it/);
  });

  it('a failed check is said on the page, not retried', async () => {
    const claude = fakeClaude({ places: [{ sizes: [right] }], checks: [new Error('overloaded')] });
    const notes = [];
    await placeChecked({ claude, pictures: { landscape: await pic() }, text: 'Hi', notes });
    expect(claude.calls).toEqual(['place', 'check']);
    expect(placeNoteText(notes)).toMatch(/not checked for faces/);
  });

  it('a failed second placement still keeps clear of the faces the check found', async () => {
    const claude = fakeClaude({ places: [{ sizes: [topCentre] }, new Error('overloaded')], checks: [onFace, ok] });
    const places = await placeChecked({ claude, pictures: { landscape: await pic() }, text: 'Hi', notes: [] });
    expect(overlapShare(places.landscape, facePx)).toBe(0);
  });

  it('no Claude key: no calls, the fixed band, and a note', async () => {
    const notes = [];
    expect(await placeChecked({ claude: null, pictures: { landscape: await pic() }, text: 'Hi', notes })).toEqual({});
    expect(notes[0].reason).toMatch(/no Claude key/);
  });
});

describe('the geometry behind it', () => {
  it('free parts never touch a block', () => {
    const blocks = [{ x0: 400, y0: 50, x1: 700, y1: 400 }, { x0: 900, y0: 0, x1: 1000, y1: 300 }];
    const parts = freeParts({ x0: 0, y0: 0, x1: W, y1: H }, blocks, { w: W, h: H, minW: 10, minH: 10 });
    expect(parts.length).toBeGreaterThan(0);
    for (const p of parts) for (const b of blocks) expect(overlapShare(p, b)).toBe(0);
  });

  it('the last try takes a smaller box rather than none', () => {
    const avoid = [{ x0: 0, y0: 0, x1: W * 0.8, y1: H }]; // leaves 81.5% to 97%: under 22%, over 12%
    expect(placeFor(null, { w: W, h: H, avoid })).toBeNull();
    expect(placeFor(null, { w: W, h: H, avoid, last: true })).toMatchObject({ how: 'beside' });
  });

  it('a check answer without ok is unusable; faces come back in pixels', () => {
    expect(checkFor({ faces: [] }, { w: W, h: H })).toBeNull();
    expect(checkFor({ ok: false, faces: [face], problem: 'x' }, { w: W, h: H }).faces[0]).toEqual(facePx);
  });
});
