import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  parseGenerateDays,
  runsToday,
  isRunDue,
  targetPostAt,
  postDateKey,
  decideFunnelRun,
} from '../src/utils/videoSchedule.js';

const ist = (iso) => DateTime.fromISO(iso, { zone: 'Asia/Kolkata' });

describe('parseGenerateDays', () => {
  it('blank = empty list (daily)', () => {
    expect(parseGenerateDays('')).toEqual([]);
    expect(parseGenerateDays(null)).toEqual([]);
    expect(parseGenerateDays(undefined)).toEqual([]);
  });
  it('splits and trims a CSV of weekday numbers', () => {
    expect(parseGenerateDays(' 1, 3 ,5')).toEqual(['1', '3', '5']);
  });
});

describe('runsToday', () => {
  // 2026-07-13 is a Monday (weekday 1), 2026-07-14 a Tuesday (weekday 2).
  it('blank list runs every day', () => {
    expect(runsToday('', ist('2026-07-13T22:00'))).toBe(true);
  });
  it('runs on a listed weekday', () => {
    expect(runsToday('1,3,5', ist('2026-07-13T22:00'))).toBe(true); // Mon
  });
  it('skips an unlisted weekday', () => {
    expect(runsToday('1,3,5', ist('2026-07-14T22:00'))).toBe(false); // Tue
  });
});

describe('isRunDue', () => {
  const base = { generateTime: '22:00', generateDays: '' };

  it('due exactly at generate_time', () => {
    expect(isRunDue({ ...base, now: ist('2026-07-13T22:00') })).toBe(true);
  });
  it('due when pinged ~10 min early (within forward window)', () => {
    expect(isRunDue({ ...base, now: ist('2026-07-13T21:50') })).toBe(true);
  });
  it('due when run slightly late (within back window)', () => {
    expect(isRunDue({ ...base, now: ist('2026-07-13T22:10') })).toBe(true);
  });
  it('not due well before the window', () => {
    expect(isRunDue({ ...base, now: ist('2026-07-13T20:00') })).toBe(false);
  });
  it('not due well after the window', () => {
    expect(isRunDue({ ...base, now: ist('2026-07-13T23:00') })).toBe(false);
  });
  it('not due on an unlisted weekday even at the right time', () => {
    expect(isRunDue({ generateTime: '22:00', generateDays: '1,3,5', now: ist('2026-07-14T22:00') })).toBe(false); // Tue
  });
  it('respects a custom window', () => {
    expect(isRunDue({ ...base, now: ist('2026-07-13T21:30'), forwardMin: 15, backMin: 15 })).toBe(false);
    expect(isRunDue({ ...base, now: ist('2026-07-13T21:30'), forwardMin: 45, backMin: 15 })).toBe(true);
  });
});

describe('targetPostAt', () => {
  it('evening generate for a morning publish targets TOMORROW', () => {
    const r = targetPostAt({ publishTime: '08:02', now: ist('2026-07-13T22:00') });
    expect(r.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-07-14 08:02');
  });
  it('an early ping before midnight still targets tomorrow morning', () => {
    const r = targetPostAt({ publishTime: '08:02', now: ist('2026-07-13T21:50') });
    expect(r.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-07-14 08:02');
  });
  it('generate before a same-day publish targets TODAY', () => {
    const r = targetPostAt({ publishTime: '20:00', now: ist('2026-07-13T06:00') });
    expect(r.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-07-13 20:00');
  });
  it('blank publish time falls back to 08:02', () => {
    const r = targetPostAt({ publishTime: '', now: ist('2026-07-13T22:00') });
    expect(r.toFormat('HH:mm')).toBe('08:02');
  });
});

describe('postDateKey', () => {
  it('is the IST calendar date of the target', () => {
    expect(postDateKey(ist('2026-07-14T08:02'))).toBe('2026-07-14');
  });
});

describe('decideFunnelRun', () => {
  it('due evening run -> tomorrow morning post, with matching date key', () => {
    const r = decideFunnelRun({
      generateTime: '22:00',
      generateDays: '',
      publishTime: '08:02',
      now: ist('2026-07-13T22:00'),
    });
    expect(r.due).toBe(true);
    expect(r.scheduledFor.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-07-14 08:02');
    expect(r.dateKey).toBe('2026-07-14');
  });
  it('not due still computes the next post datetime', () => {
    const r = decideFunnelRun({
      generateTime: '22:00',
      generateDays: '',
      publishTime: '08:02',
      now: ist('2026-07-13T12:00'),
    });
    expect(r.due).toBe(false);
    expect(r.dateKey).toBe('2026-07-14');
  });
});
