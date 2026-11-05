import { describe, it, expect } from 'vitest';
import { normalizeScheduleClean, cleanFixPlan, swapMediaUrl, cleanVideoArgs } from '../src/utils/cleanSpec.js';
import { keepSecFor } from '../src/utils/cleanHookSpec.js';
import { normalizeSelections } from '../src/utils/readyPostSpec.js';

describe('normalizeScheduleClean', () => {
  it('keeps the numbers on the panel', () => {
    expect(normalizeScheduleClean({ zoomPct: 8, trimEndSec: 4 })).toMatchObject({ zoomPct: 8, trimEndSec: 4, subs: false, endSec: 0 });
  });

  it('is null when the panel asks for nothing, so the original is posted', () => {
    expect(normalizeScheduleClean(null)).toBeNull();
    expect(normalizeScheduleClean({ zoomPct: 0, trimEndSec: 0, subs: false })).toBeNull();
  });

  it('counts subtitles alone as asking for a clean', () => {
    expect(normalizeScheduleClean({ zoomPct: 0, trimEndSec: 0, subs: true })).toMatchObject({ subs: true });
  });
});

describe('normalizeSelections', () => {
  it('carries the panel numbers to the post job', () => {
    const [s] = normalizeSelections([{ driveId: 'd1', cleanOpts: { zoomPct: 8, trimEndSec: 4 } }]);
    expect(s.cleanOpts).toMatchObject({ zoomPct: 8, trimEndSec: 4 });
  });

  it('adds nothing when no clean is asked for', () => {
    const [s] = normalizeSelections([{ driveId: 'd1', cleanOpts: null }]);
    expect('cleanOpts' in s).toBe(false);
  });
});

describe('cleanFixPlan', () => {
  const opts = { zoomPct: 8, trimEndSec: 4 };

  it('leaves a post alone that already uses its cleaned copy', () => {
    expect(cleanFixPlan({ mediaUrl: 'u/clean', clean: { url: 'u/clean', zoomPct: 8, trimEndSec: 4 }, opts })).toBe('already');
  });

  it('reuses a matching copy the post never picked up', () => {
    expect(cleanFixPlan({ mediaUrl: 'u/orig', clean: { url: 'u/clean', zoomPct: 8, trimEndSec: 4 }, opts })).toBe('reuse');
  });

  it('cleans when there is no copy, or one with other numbers', () => {
    expect(cleanFixPlan({ mediaUrl: 'u/orig', clean: null, opts })).toBe('clean');
    expect(cleanFixPlan({ mediaUrl: 'u/orig', clean: { url: 'u/clean', zoomPct: 8, trimEndSec: 0 }, opts })).toBe('clean');
  });
});

describe('swapMediaUrl', () => {
  it('replaces the video everywhere and leaves the thumbnail and captions', () => {
    const req = {
      caption: 'see https://x.io',
      mediaUrl: 'https://d/uc?id=a&export=download',
      platformConfigurations: { instagram: { caption: 'c', media: [{ url: 'https://d/uc?id=a&export=download', thumbnail_url: 'https://t/1.jpg' }] } },
    };
    const out = swapMediaUrl(req, req.mediaUrl, 'https://clean/1.mp4');
    expect(out.mediaUrl).toBe('https://clean/1.mp4');
    expect(out.platformConfigurations.instagram.media[0]).toEqual({ url: 'https://clean/1.mp4', thumbnail_url: 'https://t/1.jpg' });
    expect(out.caption).toBe('see https://x.io');
  });
});

describe('the 8% zoom and 4 s cut reach ffmpeg', () => {
  it('a 59 s video keeps 55 s, zoomed from the top', () => {
    const args = cleanVideoArgs({ input: 'in.mp4', output: 'out.mp4', zoomPct: 8, keepSec: keepSecFor(59, 4) });
    expect(args[args.indexOf('-t') + 1]).toBe('55');
    expect(args[args.indexOf('-vf') + 1]).toContain('iw*1.08');
  });
});
