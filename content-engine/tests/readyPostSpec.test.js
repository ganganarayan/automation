import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  filterReadyVideos,
  defaultSlotsIso,
  parseIstDateTime,
  defaultCaption,
  normalizeSelections,
} from '../src/utils/readyPostSpec.js';

const ist = (iso) => DateTime.fromISO(iso, { zone: 'Asia/Kolkata' });

describe('filterReadyVideos', () => {
  it('keeps unposted videos, drops non-video and POSTED', () => {
    const files = [
      { id: '1', name: 'reel-a.mp4', mimeType: 'video/mp4' },
      { id: '2', name: 'POSTED - reel-b.mp4', mimeType: 'video/mp4' },
      { id: '3', name: 'thumb.png', mimeType: 'image/png' },
      { id: '4', name: 'reel-c.mov', mimeType: 'video/quicktime' },
    ];
    expect(filterReadyVideos(files).map((f) => f.id)).toEqual(['1', '4']);
  });
  it('handles junk', () => {
    expect(filterReadyVideos(null)).toEqual([]);
  });
});

describe('defaultSlotsIso', () => {
  it('starts at the next publish slot ahead of now, then consecutive days', () => {
    const slots = defaultSlotsIso('08:02', 3, ist('2026-07-13T22:00'));
    const fmt = slots.map((s) => ist(s).toFormat('yyyy-MM-dd HH:mm'));
    expect(fmt).toEqual(['2026-07-14 08:02', '2026-07-15 08:02', '2026-07-16 08:02']);
  });
  it('uses today when the slot is still ahead', () => {
    const slots = defaultSlotsIso('20:00', 2, ist('2026-07-13T06:00'));
    const fmt = slots.map((s) => ist(s).toFormat('yyyy-MM-dd HH:mm'));
    expect(fmt).toEqual(['2026-07-13 20:00', '2026-07-14 20:00']);
  });
  it('count 0 => empty', () => {
    expect(defaultSlotsIso('08:02', 0, ist('2026-07-13T22:00'))).toEqual([]);
  });
});

describe('parseIstDateTime', () => {
  it('parses DD-MM-YYYY HH:MM as IST', () => {
    const iso = parseIstDateTime('14-07-2026 08:02');
    expect(ist(iso).toFormat('yyyy-MM-dd HH:mm')).toBe('2026-07-14 08:02');
    expect(iso).toContain('+05:30');
  });
  it('returns null on garbage', () => {
    expect(parseIstDateTime('not a date')).toBeNull();
    expect(parseIstDateTime('')).toBeNull();
    expect(parseIstDateTime('2026-07-14 08:02')).toBeNull(); // wrong order
  });
});

describe('defaultCaption', () => {
  it('joins audience prefix + cta', () => {
    expect(defaultCaption({ audiencePrefix: 'For founders', ctaLink: 'https://x.co/a' })).toBe('For founders\nhttps://x.co/a');
  });
  it('prefers the direct-upload caption over the audience prefix', () => {
    expect(defaultCaption({ directCaption: 'Watch this', audiencePrefix: 'For founders', ctaLink: 'https://x.co/a' }))
      .toBe('Watch this\nhttps://x.co/a');
  });
  it('does not duplicate a link already in the caption', () => {
    expect(defaultCaption({ directCaption: 'Watch this https://x.co/a', ctaLink: 'https://x.co/a' }))
      .toBe('Watch this https://x.co/a');
  });
  it('tolerates blanks', () => {
    expect(defaultCaption({ ctaLink: 'https://x.co/a' })).toBe('https://x.co/a');
    expect(defaultCaption({})).toBe('');
  });
});

describe('normalizeSelections', () => {
  it('preserves tick order and de-dupes', () => {
    const out = normalizeSelections([
      { driveId: 'c', caption: 'C', name: 'c.mp4' },
      { driveId: 'a', caption: 'A' },
      { driveId: 'c', caption: 'dup' },
      { driveId: '', caption: 'skip' },
    ]);
    expect(out.map((s) => s.driveId)).toEqual(['c', 'a']);
    expect(out[0]).toEqual({ driveId: 'c', name: 'c.mp4', caption: 'C', scheduledAt: '', now: false });
  });
  it('carries the post-now flag', () => {
    const out = normalizeSelections([{ driveId: 'a', now: true }, { driveId: 'b' }]);
    expect(out[0].now).toBe(true);
    expect(out[1].now).toBe(false);
  });
});
