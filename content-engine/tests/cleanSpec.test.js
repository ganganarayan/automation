import { describe, it, expect } from 'vitest';
import { normalizeCleanOpts, cleanVideoArgs } from '../src/utils/cleanSpec.js';

describe('cleanSpec', () => {
  it('clamps zoom and trim', () => {
    expect(normalizeCleanOpts({ zoomPct: 99, trimEndSec: -3 })).toEqual({ zoomPct: 30, trimEndSec: 0 });
    expect(normalizeCleanOpts({ zoomPct: 'x', trimEndSec: '4.5' })).toEqual({ zoomPct: 10, trimEndSec: 4.5 });
  });
  it('zooms anchored at the top and keeps the first seconds', () => {
    const a = cleanVideoArgs({ input: 'https://v', output: '/t/o.mp4', zoomPct: 10, keepSec: 120 });
    expect(a.slice(0, 5)).toEqual(['-y', '-i', 'https://v', '-t', '120']);
    const vf = a[a.indexOf('-vf') + 1];
    expect(vf).toContain('scale=trunc(iw*1.1/2)*2');
    expect(vf).toMatch(/crop=.*:\(iw-ow\)\/2:0,/);
    expect(a.at(-1)).toBe('/t/o.mp4');
  });
  it('no zoom and no trim leaves the frame and length alone', () => {
    const a = cleanVideoArgs({ input: 'i', output: 'o', zoomPct: 0, keepSec: 0 });
    expect(a).not.toContain('-t');
    expect(a[a.indexOf('-vf') + 1]).toBe('setsar=1');
  });
});
