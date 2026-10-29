import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  filterReadyVideos,
  defaultSlotsIso,
  parseIstDateTime,
  defaultCaption,
  normalizeSelections,
  parseDriveFolderId,
  parsePickedFiles,
  parseEmbeddedFolder,
  normalizePickedAccounts,
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

describe('parseDriveFolderId', () => {
  const ID = '1AbCdEfGhIjKlMnOpQrStUv_-9';
  it('reads a folder link, an ?id= link and a bare ID', () => {
    expect(parseDriveFolderId(`https://drive.google.com/drive/folders/${ID}?usp=sharing`)).toBe(ID);
    expect(parseDriveFolderId(`https://drive.google.com/drive/u/0/folders/${ID}`)).toBe(ID);
    expect(parseDriveFolderId(`https://drive.google.com/open?id=${ID}`)).toBe(ID);
    expect(parseDriveFolderId(`  ${ID} `)).toBe(ID);
  });
  it('returns empty for junk', () => {
    expect(parseDriveFolderId('')).toBe('');
    expect(parseDriveFolderId('not a link')).toBe('');
  });
});

describe('parsePickedFiles', () => {
  const ID = '1AbCdEfGhIjKlMnOpQrStUv_-9';
  it('keeps valid picked files, de-duped', () => {
    const raw = JSON.stringify([{ id: ID, name: 'a.mp4' }, { id: ID, name: 'dup' }, { id: 'bad id!', name: 'x' }, { id: '2ZyXwVuTsRqPoNmLkJ', name: '' }]);
    expect(parsePickedFiles(raw)).toEqual([{ id: ID, name: 'a.mp4' }, { id: '2ZyXwVuTsRqPoNmLkJ', name: '2ZyXwVuTsRqPoNmLkJ' }]);
  });
  it('returns [] for junk', () => {
    expect(parsePickedFiles('')).toEqual([]);
    expect(parsePickedFiles('{oops')).toEqual([]);
    expect(parsePickedFiles('{"id":"x"}')).toEqual([]);
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
    expect(out[0]).toEqual({ driveId: 'c', name: 'c.mp4', caption: 'C', scheduledAt: '', now: false, copy: null, costs: [], thumbs: {} });
  });
  it('carries AI copy and keeps only numeric cost entries', () => {
    const out = normalizeSelections([{ driveId: 'a', copy: { title: 'T' }, costs: [{ costUsd: 0.01 }, { costUsd: 'x' }, null] }]);
    expect(out[0].copy).toEqual({ title: 'T' });
    expect(out[0].costs).toEqual([{ costUsd: 0.01 }]);
  });
  it('carries the post-now flag', () => {
    const out = normalizeSelections([{ driveId: 'a', now: true }, { driveId: 'b' }]);
    expect(out[0].now).toBe(true);
    expect(out[1].now).toBe(false);
  });
});

describe('parseEmbeddedFolder', () => {
  const entry = (id, name, href, icon) => `<div class="flip-entry" id="entry-${id}" tabindex="0" role="link"><div class="flip-entry-info"><a href="${href}" target="_blank"><div class="flip-entry-list-icon"><img src="https://drive-thirdparty.googleusercontent.com/16/type/${icon}" alt=""/></div><div class="flip-entry-title">${name}</div></a></div></div>`;
  const html = '<div class="flip-entries">'
    + entry('1zNT6Lv7QDX6SN9RjP6XIcsW8WTzwwg50', 'Gita &amp; Life.mov', 'https://drive.google.com/file/d/1zNT6Lv7QDX6SN9RjP6XIcsW8WTzwwg50/view?usp=drive_web', 'video/quicktime')
    + entry('1SubFolderIdAbCdEfGhIj', 'Archive', 'https://drive.google.com/drive/folders/1SubFolderIdAbCdEfGhIj', 'application/vnd.google-apps.folder')
    + entry('1LFG2xVPDJwT32SZQeFTAsIP-CGJDIub4', 'notes.pdf', 'https://drive.google.com/file/d/1LFG2xVPDJwT32SZQeFTAsIP-CGJDIub4/view', 'application/pdf')
    + '</div>';
  it('lists files with names + mime types, skipping sub-folders', () => {
    const out = parseEmbeddedFolder(html);
    expect(out.map((f) => [f.id, f.name, f.mimeType])).toEqual([
      ['1zNT6Lv7QDX6SN9RjP6XIcsW8WTzwwg50', 'Gita & Life.mov', 'video/quicktime'],
      ['1LFG2xVPDJwT32SZQeFTAsIP-CGJDIub4', 'notes.pdf', 'application/pdf'],
    ]);
    expect(filterReadyVideos(out).map((f) => f.id)).toEqual(['1zNT6Lv7QDX6SN9RjP6XIcsW8WTzwwg50']);
  });
  it('returns [] for a sign-in / empty page', () => {
    expect(parseEmbeddedFolder('<title>Sign in</title>')).toEqual([]);
    expect(parseEmbeddedFolder(null)).toEqual([]);
  });
});

describe('normalizePickedAccounts', () => {
  it('keeps valid ticked accounts, de-duped', () => {
    expect(normalizePickedAccounts([{ id: 'spc_abc', platform: 'instagram', name: 'gita' }, { id: 'spc_abc' }, { id: 'x' }, null]))
      .toEqual([{ id: 'spc_abc', platform: 'instagram', name: 'gita' }]);
    expect(normalizePickedAccounts('junk')).toEqual([]);
  });
});
