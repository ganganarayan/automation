import { describe, it, expect } from 'vitest';
import { routerCleanOpts, autoCheckTimes, autoCleanFromFrames } from '../src/utils/cleanSpec.js';

describe('routerCleanOpts', () => {
  it('is off with blank config, checks 15 s, no card', () => {
    expect(routerCleanOpts({})).toEqual({ on: false, checkSec: 15, endText: '', endLink: '', endSec: 0 });
  });
  it('reads the funnel fields, card 4 s when no seconds given', () => {
    const o = routerCleanOpts({ direct_clean: 'on', direct_clean_check_sec: '4', direct_clean_end_text: 'Book a call', direct_clean_end_link: 'https://x.y' });
    expect(o).toEqual({ on: true, checkSec: 4, endText: 'Book a call', endLink: 'https://x.y', endSec: 4 });
    expect(routerCleanOpts({ direct_clean: 'on', direct_clean_end_text: 'x', direct_clean_end_sec: '0' })).toMatchObject({ endSec: 0 });
  });
  it('ignores the old zoom, cut and auto-check values still saved on a funnel', () => {
    const o = routerCleanOpts({ direct_clean: 'on', direct_clean_auto: 'off', direct_clean_zoom: '20', direct_clean_trim: '4' });
    expect(o).toEqual({ on: true, checkSec: 15, endText: '', endLink: '', endSec: 0 });
  });
  it('keeps the check window in range', () => {
    expect(routerCleanOpts({ direct_clean_check_sec: '500' }).checkSec).toBe(30);
    expect(routerCleanOpts({ direct_clean_check_sec: 'abc' }).checkSec).toBe(15);
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
  it('a chosen window of 4 s takes 4 snaps at the end', () => {
    expect(autoCheckTimes(60, 4).tail).toEqual([56, 57, 58, 59]);
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
  it('only a trailing run counts as outro; unknown watermark height uses the standard zoom', () => {
    const frames = [{ watermark: true }, { outro: true }, {}, {}, {}, { outro: true }];
    expect(autoCleanFromFrames({ frames, tail, totalSec: 60 })).toEqual({ zoomPct: 10, trimEndSec: 1.5, watermark: true, outro: true });
  });
  it('no answer, or not one per frame = no result, nothing cut', () => {
    const none = { zoomPct: 0, trimEndSec: 0, watermark: null, outro: null };
    expect(autoCleanFromFrames({ frames: null, tail, totalSec: 60 })).toEqual(none);
    expect(autoCleanFromFrames({ frames: [{}, { outro: true }], tail, totalSec: 60 })).toEqual(none);
  });
});
