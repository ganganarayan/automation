import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  parseTime, parseTimeList, tenantTimes, buildWakeSchedule, isDue, anyDue, variableRequests, syncOutcome,
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
  it('is due from the time itself up to the window', () => {
    expect(isDue('16:00', ist('16:00'))).toBe(true);
    expect(isDue('16:00', ist('16:29'))).toBe(true);
    expect(isDue('16:00', ist('16:30'))).toBe(false);
    expect(isDue('16:00', ist('15:59'))).toBe(false);
  });
  it('crosses midnight', () => {
    expect(isDue('23:50', ist('00:10'))).toBe(true);
    expect(isDue('00:10', ist('23:50'))).toBe(false);
  });
  it('takes a custom window, and anyDue checks a list', () => {
    expect(isDue('16:00', ist('16:35'), 40)).toBe(true);
    expect(anyDue(['08:20', '20:20'], ist('20:30'))).toBe(true);
    expect(anyDue(['08:20', '20:20'], ist('12:00'))).toBe(false);
    expect(isDue('bad', ist('12:00'))).toBe(false);
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
