import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  gitaImageScheduledAt,
  vidapulseImageScheduledAt,
  gitaVideoScheduledAt,
  simpleVideoScheduledAt,
} from '../src/utils/scheduling.js';

const ist = (iso) => DateTime.fromISO(iso, { zone: 'Asia/Kolkata' });

describe('gitaImageScheduledAt', () => {
  it('schedules tomorrow 08:02 when hour >= 21', () => {
    const r = gitaImageScheduledAt(ist('2026-07-11T22:00'));
    expect(r.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-07-12 08:02');
  });
  it('schedules today 08:02 when before 08:00', () => {
    const r = gitaImageScheduledAt(ist('2026-07-11T06:00'));
    expect(r.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-07-11 08:02');
  });
  it('schedules now + 5 minutes during the day', () => {
    const r = gitaImageScheduledAt(ist('2026-07-11T12:00'));
    expect(r.toFormat('HH:mm')).toBe('12:05');
  });
});

describe('vidapulseImageScheduledAt', () => {
  it('today 10:00 when before 10:00', () => {
    expect(vidapulseImageScheduledAt(ist('2026-07-11T09:00')).toFormat('yyyy-MM-dd HH:mm')).toBe('2026-07-11 10:00');
  });
  it('tomorrow 10:00 when after 10:00', () => {
    expect(vidapulseImageScheduledAt(ist('2026-07-11T11:00')).toFormat('yyyy-MM-dd HH:mm')).toBe('2026-07-12 10:00');
  });
});

describe('gitaVideoScheduledAt', () => {
  it('today 10:02 when before', () => {
    expect(gitaVideoScheduledAt(ist('2026-07-11T09:00')).toFormat('HH:mm')).toBe('10:02');
  });
  it('now + 1 minute when past 10:02', () => {
    expect(gitaVideoScheduledAt(ist('2026-07-11T12:00')).toFormat('HH:mm')).toBe('12:01');
  });
});

describe('simpleVideoScheduledAt', () => {
  it('today 11:00 when before', () => {
    expect(simpleVideoScheduledAt(ist('2026-07-11T09:00')).toFormat('yyyy-MM-dd HH:mm')).toBe('2026-07-11 11:00');
  });
  it('tomorrow 11:00 when past', () => {
    expect(simpleVideoScheduledAt(ist('2026-07-11T12:00')).toFormat('yyyy-MM-dd HH:mm')).toBe('2026-07-12 11:00');
  });
});
