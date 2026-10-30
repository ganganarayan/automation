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

import { progressSeconds, progressPct } from '../src/utils/cleanSpec.js';

describe('clean progress', () => {
  it('reads the last out_time from an ffmpeg -progress chunk', () => {
    expect(progressSeconds('frame=10\nout_time_us=1500000\nout_time_ms=2500000\nprogress=continue\n')).toBe(2.5);
    expect(progressSeconds('progress=continue')).toBe(-1);
  });
  it('turns seconds into a running percent', () => {
    expect(progressPct(30, 60)).toBe(50);
    expect(progressPct(61, 60)).toBe(99);
    expect(progressPct(10, 0)).toBe(0);
  });
});

import { normalizeEndCard, endCardSvg, cleanWithCardArgs } from '../src/utils/cleanSpec.js';

describe('end card', () => {
  it('clamps seconds; no text and no link = no card', () => {
    expect(normalizeEndCard({ endText: ' Take the test ', endLink: 'https://x.y', endSec: 40 })).toEqual({ endText: 'Take the test', endLink: 'https://x.y', endSec: 15 });
    expect(normalizeEndCard({ endText: '', endLink: '', endSec: 4 }).endSec).toBe(0);
  });
  it('draws centred white lines on black, link last, escaped', () => {
    const svg = endCardSvg({ w: 1080, h: 1920, text: 'Take the free <assessment> today', link: 'https://x.y/a?b=1&c=2' });
    expect(svg).toContain('fill="#000000"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('&lt;assessment&gt;');
    expect(svg.lastIndexOf('https://x.y/a?b=1&amp;c=2')).toBeGreaterThan(svg.indexOf('Take'));
  });
  it('appends the card (with silence) after the trimmed, zoomed video', () => {
    const a = cleanWithCardArgs({ input: 'https://v', card: '/t/c.png', output: '/t/o.mp4', zoomPct: 8, keepSec: 70, cardSec: 4, w: 1081, h: 1920, fps: 29.97, hasAudio: true });
    expect(a.slice(0, 5)).toEqual(['-y', '-t', '70', '-i', 'https://v']);
    expect(a).toContain('anullsrc=r=48000:cl=stereo');
    const g = a[a.indexOf('-filter_complex') + 1];
    expect(g).toContain('scale=1082:1920,setsar=1,fps=30');
    expect(g).toContain('concat=n=2:v=1:a=1');
    const silent = cleanWithCardArgs({ input: 'i', card: 'c', output: 'o', zoomPct: 0, cardSec: 4, w: 720, h: 1280, hasAudio: false });
    expect(silent).not.toContain('-c:a');
    expect(silent[silent.indexOf('-filter_complex') + 1]).toContain('concat=n=2:v=1:a=0');
  });
});
