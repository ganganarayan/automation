import { describe, it, expect } from 'vitest';
import { routerCleanOpts, autoCheckTimes, autoCleanFromFrames } from '../src/utils/cleanSpec.js';

describe('routerCleanOpts', () => {
  it('is off with blank config, defaults zoom 10 and no card', () => {
    expect(routerCleanOpts({})).toEqual({ on: false, auto: false, zoomPct: 10, trimEndSec: 0, endText: '', endLink: '', endSec: 0 });
  });
  it('reads the funnel fields, clamped, card 4 s when no seconds given', () => {
    const o = routerCleanOpts({ direct_clean: 'on', direct_clean_auto: 'on', direct_clean_zoom: '45', direct_clean_trim: '5', direct_clean_end_text: 'Book a call', direct_clean_end_link: 'https://x.y' });
    expect(o).toEqual({ on: true, auto: true, zoomPct: 30, trimEndSec: 5, endText: 'Book a call', endLink: 'https://x.y', endSec: 4 });
    expect(routerCleanOpts({ direct_clean: 'on', direct_clean_zoom: '0', direct_clean_end_text: 'x', direct_clean_end_sec: '0' })).toMatchObject({ zoomPct: 0, endSec: 0 });
  });
});

describe('autoCheckTimes', () => {
  it('one early frame and one a second over the last 15 s', () => {
    const t = autoCheckTimes(60);
    expect(t.early).toBe(3);
    expect(t.tail).toEqual([45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
  });
  it('short and unknown lengths', () => {
    expect(autoCheckTimes(5)).toEqual({ early: 0.5, tail: [1, 2, 3, 4] });
    expect(autoCheckTimes(0)).toEqual({ early: 1, tail: [] });
  });
});

describe('autoCleanFromFrames', () => {
  const tail = [55, 56, 57, 58, 59];
  it('zooms just past the watermark and cuts at the outro', () => {
    const frames = [{ watermark: true, watermarkBottomPct: 6 }, {}, {}, { outro: true }, { outro: true }, { outro: true }];
    expect(autoCleanFromFrames({ frames, tail, totalSec: 60 })).toEqual({ zoomPct: 8.7, trimEndSec: 3.5, watermark: true, outro: true });
  });
  it('no watermark and no outro = no zoom, no cut', () => {
    expect(autoCleanFromFrames({ frames: [{}, {}, {}, {}, {}, {}], tail, totalSec: 60 })).toEqual({ zoomPct: 0, trimEndSec: 0, watermark: false, outro: false });
  });
  it('only a trailing run counts as outro; unknown watermark height uses the fallback zoom', () => {
    const frames = [{ watermark: true }, { outro: true }, {}, {}, {}, { outro: true }];
    expect(autoCleanFromFrames({ frames, tail, totalSec: 60, fallback: { zoomPct: 12 } })).toEqual({ zoomPct: 12, trimEndSec: 1.5, watermark: true, outro: true });
  });
  it('no answer = the fallback', () => {
    expect(autoCleanFromFrames({ frames: null, tail, totalSec: 60, fallback: { zoomPct: 9, trimEndSec: 4 } })).toEqual({ zoomPct: 9, trimEndSec: 4, watermark: null, outro: null });
  });
});
