import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  routerTarget, runsOn, laneForInstance, existingReason, postAtFor, colLetter, planHeader, readyRows,
  pickReadyRow, nextMatchKeys, htmlToText, historyLines, instanceHistoryLine, sheetHistory, sheetColumns,
  refillPrompt, normalizeRefill, rowsForSheet, REFILL_COUNT,
} from '../src/utils/routerSpec.js';

const ist = (iso) => DateTime.fromISO(iso, { zone: 'Asia/Kolkata' });

const header = ['day', 'image_prompt', 'caption', 'headline', 'status'];
const rows = [
  header,
  ['1', 'a river', 'cap one', 'Flow', 'Posted'],
  ['2', 'a mountain', 'cap two', 'Rise', 'Ready'],
  ['3', 'a lamp', 'cap three', 'Light', 'ready'],
  ['4', '', 'no prompt', '', 'Ready'],
];

describe('routerTarget', () => {
  it('targets tomorrow at the publish time (IST)', () => {
    const { scheduledFor, postDate } = routerTarget('08:02', ist('2026-11-01T16:00'));
    expect(postDate).toBe('2026-11-02');
    expect(scheduledFor.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-11-02 08:02');
  });
  it('defaults a blank publish time to 08:02', () => {
    expect(routerTarget('', ist('2026-12-31T16:00')).scheduledFor.toFormat('yyyy-MM-dd HH:mm')).toBe('2027-01-01 08:02');
  });
});

describe('runsOn', () => {
  it('blank = every day; otherwise the IST weekday', () => {
    const sun = ist('2026-11-01T16:00'); // Sunday = 7
    expect(runsOn('', sun)).toBe(true);
    expect(runsOn('1,2,3', sun)).toBe(false);
    expect(runsOn('7', sun)).toBe(true);
  });
});

describe('laneForInstance / existingReason', () => {
  it('maps source types to router lanes', () => {
    expect(laneForInstance({ source_type: 'sheet' })).toBe('image');
    expect(laneForInstance({ source_type: 'drive_folder' })).toBe('ready_video');
    expect(laneForInstance({ source_type: 'drive_pick' })).toBe('ready_video');
    expect(laneForInstance({ source_type: 'generated' })).toBe('ai_video');
    expect(laneForInstance({ source_type: null, status: 'script_review' })).toBe('ai_video');
  });
  it('says already scheduled only for scheduled/posted/partial', () => {
    expect(existingReason({ status: 'scheduled' })).toBe('already scheduled');
    expect(existingReason({ status: 'final_review' })).toBe('already in progress (final_review)');
  });
});

describe('postAtFor (D2)', () => {
  const now = new Date('2026-11-02T02:00:00Z');
  it('keeps a future time', () => {
    expect(postAtFor('2026-11-02T02:32:00Z', now)).toBe('2026-11-02T02:32:00.000Z');
  });
  it('posts now when the time has passed or is missing', () => {
    expect(postAtFor('2026-11-02T01:00:00Z', now)).toBeNull();
    expect(postAtFor(null, now)).toBeNull();
  });
});

describe('sheet helpers', () => {
  it('colLetter', () => {
    expect(colLetter(0)).toBe('A');
    expect(colLetter(25)).toBe('Z');
    expect(colLetter(26)).toBe('AA');
  });
  it('planHeader adds only the missing columns, case-insensitively', () => {
    const plan = planHeader(['Day', 'Status', 'Source'], ['source', 'pfm_post_id']);
    expect(plan.added).toEqual([{ index: 3, name: 'pfm_post_id' }]);
    expect(plan.header).toEqual(['Day', 'Status', 'Source', 'pfm_post_id']);
  });
  it('readyRows needs Ready + a prompt; pickReadyRow skips open keys', () => {
    expect(readyRows(rows).map((r) => r.key)).toEqual(['2', '3']);
    expect(pickReadyRow(rows, ['2']).rowNumber).toBe(4);
    expect(pickReadyRow(rows, ['2', '3'])).toBeNull();
  });
  it('rows without a key column are keyed by row number', () => {
    const r = [['image_prompt', 'status'], ['x', 'Ready']];
    expect(pickReadyRow(r, []).key).toBe('row:2');
  });
  it('nextMatchKeys continues numeric keys, else dated auto keys', () => {
    expect(nextMatchKeys(rows, 3)).toEqual(['5', '6', '7']);
    const named = [['id', 'image_prompt', 'status'], ['gita-a', 'p', 'Ready']];
    expect(nextMatchKeys(named, 2, ist('2026-11-01T16:00'))).toEqual(['auto-20261101-1600-1', 'auto-20261101-1600-2']);
    expect(nextMatchKeys([['image_prompt', 'status']], 2)).toEqual([]);
  });
  it('sheetColumns reports what the sheet can hold', () => {
    expect(sheetColumns(header)).toMatchObject({ prompt: true, caption: true, headline: true, hashtags: false, captionShort: false });
  });
});

describe('rowsForSheet', () => {
  it('fills only existing columns, status Ready, source Auto, the key', () => {
    const h = ['day', 'image_prompt', 'caption', 'headline', 'status', 'source'];
    const out = rowsForSheet(h, [{ imagePrompt: 'p', caption: 'c', headline: 'H', hashtags: '#x', captionShort: '' }], ['9']);
    expect(out).toEqual([['9', 'p', 'c', 'H', 'Ready', 'Auto']]);
  });
  it('maps the caption to full + short on a Corporate-style sheet', () => {
    const h = ['Post #', 'image prompt', 'LinkedIn Long Caption (full post)', 'Short Caption (other 6 channels, optional)', 'Hashtags', 'Status', 'source'];
    const [row] = rowsForSheet(h, [{ imagePrompt: 'p', caption: 'long', captionShort: 'short', hashtags: '#a #b' }], ['13']);
    expect(row).toEqual(['13', 'p', 'long', 'short', '#a #b', 'Ready', 'Auto']);
  });
});

describe('research input', () => {
  it('htmlToText strips scripts/tags/entities and caps the length', () => {
    const html = '<html><head><style>x{}</style><script>alert(1)</script></head><body><h1>Calm&nbsp;Mind</h1><p>Breathe &amp; focus.</p></body></html>';
    expect(htmlToText(html)).toBe('Calm Mind\nBreathe & focus.');
    expect(htmlToText(`<p>${'a'.repeat(50)}</p>`, 10)).toBe(`${'a'.repeat(10)} …`);
  });
  it('historyLines de-duplicates and caps', () => {
    expect(historyLines(['A', 'a', ' ', 'B', 'C'], 2)).toEqual(['A', 'B']);
  });
  it('instanceHistoryLine uses the copy title + posted caption', () => {
    const row = { title: 'Image post · 02-11-2026', steps: JSON.stringify([{ key: 'script', artifacts: { copy: { title: 'Rise' } } }, { key: 'publish', artifacts: { request: { caption: 'cap' } } }]) };
    expect(instanceHistoryLine(row)).toBe('Rise · cap');
    expect(instanceHistoryLine({ title: 'Ready video · 01-11-2026', steps: [] })).toBe('Ready video');
  });
  it('sheetHistory lists rows newest first', () => {
    expect(sheetHistory(rows.slice(0, 3))).toEqual(['Rise · cap two · a mountain', 'Flow · cap one · a river']);
  });
  it('refillPrompt asks for the sheet columns and includes landing page + history', () => {
    const { system, user } = refillPrompt({
      funnelName: 'Gita', landingUrl: 'https://x.co', landingText: 'Calm mind course', history: ['Rise · cap two'],
      examples: ['a mountain'], columns: sheetColumns(header),
    });
    expect(system).toContain(`${REFILL_COUNT} objects`);
    expect(system).toContain('"headline"');
    expect(system).not.toContain('"hashtags"');
    expect(user).toContain('Calm mind course');
    expect(user).toContain('- Rise · cap two');
    expect(user).toContain('- a mountain');
  });
  it('normalizeRefill keeps posts with a prompt, joins hashtag arrays, caps the count', () => {
    const data = { posts: [{ imagePrompt: 'p1', hashtags: ['#a', '#b'] }, { caption: 'no prompt' }, { image_prompt: 'p2' }, { prompt: 'p3' }] };
    const out = normalizeRefill(data, 2);
    expect(out.map((p) => p.imagePrompt)).toEqual(['p1', 'p2']);
    expect(out[0].hashtags).toBe('#a #b');
    expect(normalizeRefill(null)).toEqual([]);
  });
});
