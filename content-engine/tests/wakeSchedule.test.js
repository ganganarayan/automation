import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  parseTime, parseTimeList, tenantTimes, buildWakeSchedule, isDue, anyDue, variableRequests, syncOutcome,
  dueSlot, ranKey, WAKE_WINDOW_MIN,
} from '../src/utils/wakeSchedule.js';
import { buildSaveOps } from '../src/services/configOps.js';

const ist = (hhmm) => DateTime.fromISO(`2026-11-01T${hhmm}`, { zone: 'Asia/Kolkata' });

describe('parseTime / parseTimeList', () => {
  it('accepts 24-hour HH:MM and pads a one-digit hour', () => {
    expect(parseTime('16:00')).toBe('16:00');
    expect(parseTime(' 8:20 ')).toBe('08:20');
    expect(parseTime('23:59')).toBe('23:59');
  });
  it('rejects anything else', () => {
    for (const bad of ['24:00', '12:60', '4pm', '1600', '', null, '12:5']) expect(parseTime(bad)).toBeNull();
  });
  it('splits a comma list, sorts and de-dupes, and reports bad entries', () => {
    expect(parseTimeList('20:20, 08:20,8:20')).toEqual({ times: ['08:20', '20:20'], bad: [] });
    expect(parseTimeList('08:20, 9pm').bad).toEqual(['9pm']);
  });
});

describe('buildWakeSchedule', () => {
  it('uses the defaults when nothing is set', () => {
    expect(buildWakeSchedule([])).toEqual({ router: ['16:00'], nudge: ['10:00'], posts: ['08:20', '20:20'] });
    expect(tenantTimes({ router_check_time: '', post_check_times: ' ' })).toEqual({ router: ['16:00'], nudge: ['10:00'], posts: ['08:20', '20:20'] });
  });
  it('is the union across tenants', () => {
    const s = buildWakeSchedule([
      { router_check_time: '15:30', post_check_times: '08:20' },
      { nudge_time: '09:45', post_check_times: '21:00, 08:20' },
    ]);
    expect(s).toEqual({ router: ['15:30', '16:00'], nudge: ['09:45', '10:00'], posts: ['08:20', '21:00'] });
  });
});

describe('isDue', () => {
  it('is due from the time itself for the 6-hour catch-up window', () => {
    expect(WAKE_WINDOW_MIN).toBe(360);
    expect(isDue('16:00', ist('16:00'))).toBe(true);
    expect(isDue('16:00', ist('21:59'))).toBe(true);
    expect(isDue('16:00', ist('22:00'))).toBe(false);
    expect(isDue('16:00', ist('15:59'))).toBe(false);
  });
  it('crosses midnight', () => {
    expect(isDue('23:50', ist('00:10'))).toBe(true);
    expect(isDue('00:10', ist('23:50'))).toBe(false);
  });
  it('takes a custom window, and anyDue checks a list', () => {
    expect(isDue('16:00', ist('16:35'), 30)).toBe(false);
    expect(isDue('16:00', ist('16:35'), 40)).toBe(true);
    expect(anyDue(['08:20', '20:20'], ist('20:30'))).toBe(true);
    expect(anyDue(['08:20', '20:20'], ist('15:00'))).toBe(false);
    expect(isDue('bad', ist('12:00'))).toBe(false);
  });
});

describe('dueSlot', () => {
  it('catches up on the first run hours after the time (GitHub ran at 22:25, 02:26, 05:42, 11:35)', () => {
    expect(dueSlot(['16:00'], ist('19:40'))).toEqual({ time: '16:00', key: '2026-11-01 16:00' });
    expect(dueSlot(['10:00'], ist('11:35'))).toEqual({ time: '10:00', key: '2026-11-01 10:00' });
    expect(dueSlot(['16:00'], ist('15:00'))).toBeNull();
  });
  it('picks the most recent of several times', () => {
    expect(dueSlot(['08:20', '20:20'], ist('22:25'))).toEqual({ time: '20:20', key: '2026-11-01 20:20' });
    expect(dueSlot(['08:20', '20:20'], ist('09:00'))).toEqual({ time: '08:20', key: '2026-11-01 08:20' });
  });
  it('a time before midnight seen after it belongs to the day before', () => {
    expect(dueSlot(['23:50'], ist('00:10'))).toEqual({ time: '23:50', key: '2026-10-31 23:50' });
  });
  it('names the run marker per job', () => {
    expect(ranKey('router')).toBe('wake_ran_router');
  });
});

describe('variableRequests / syncOutcome', () => {
  it('PATCHes the variable and can POST to create it', () => {
    const { patch, post } = variableRequests({ repo: 'https://github.com/o/r.git', token: 't', value: '{"router":["16:00"]}' });
    expect(patch.url).toBe('https://api.github.com/repos/o/r/actions/variables/WAKE_SCHEDULE');
    expect(patch.init.method).toBe('PATCH');
    expect(post.url).toBe('https://api.github.com/repos/o/r/actions/variables');
    expect(JSON.parse(post.init.body)).toEqual({ name: 'WAKE_SCHEDULE', value: '{"router":["16:00"]}' });
  });
  it('needs a token and a repo', () => {
    expect(() => variableRequests({ repo: 'o/r', token: '', value: '' })).toThrow(/token/);
    expect(() => variableRequests({ repo: 'nope', token: 't', value: '' })).toThrow(/owner\/name/);
  });
  it('reads GitHub answers', () => {
    expect(syncOutcome(204).ok).toBe(true);
    expect(syncOutcome(201).ok).toBe(true);
    expect(syncOutcome(403).message).toMatch(/Variables: Read and write/);
    expect(syncOutcome(422, 'bad value')).toEqual({ ok: false, message: 'GitHub said 422: bad value' });
  });
});

describe('Daily schedule fields on save', () => {
  const save = (set) => buildSaveOps('content-engine', { settings: set, modules: {} });
  it('normalizes valid times and deletes blanks (default applies)', () => {
    const { sets, dels, errors } = save({ router_check_time: '9:05', post_check_times: '20:20,08:20', nudge_time: '' });
    expect(errors).toEqual([]);
    expect(sets).toContainEqual({ key: 'router_check_time', value: '09:05' });
    expect(sets).toContainEqual({ key: 'post_check_times', value: '08:20, 20:20' });
    expect(dels).toContain('nudge_time');
  });
  it('rejects a bad time with a clear error', () => {
    const { errors } = save({ router_check_time: '25:00', post_check_times: '08:20, 9pm' });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/HH:MM, 24-hour/);
    expect(errors[1]).toMatch(/"9pm"/);
  });
});
