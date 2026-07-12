import { describe, it, expect } from 'vitest';
import { computeDailyQuota } from '../src/utils/ramp.js';

const control = {
  daily_limit: 300,
  ramp_base: 30,
  ramp_step: 30,
  warmup_days: 5,
  ramp_day: 0,
};

describe('computeDailyQuota', () => {
  it('uses ramp_base during warmup', () => {
    const r = computeDailyQuota({ ...control, ramp_day: 0 }, () => 0);
    expect(r.day).toBe(1);
    expect(r.target).toBe(30);
    expect(r.atCap).toBe(false);
  });

  it('ramps after warmup', () => {
    // day = 7, after 5 warmup days: 30 + (7-5)*30 = 90
    const r = computeDailyQuota({ ...control, ramp_day: 6 }, () => 0);
    expect(r.day).toBe(7);
    expect(r.target).toBe(90);
  });

  it('caps at daily_limit and shaves at the cap', () => {
    // day large enough to exceed cap; rand=0 => no shave => exactly the cap
    const r = computeDailyQuota({ ...control, ramp_day: 100 }, () => 0);
    expect(r.atCap).toBe(true);
    expect(r.target).toBe(300);
  });

  it('shaves up to 12% at the cap with rand=1', () => {
    const r = computeDailyQuota({ ...control, ramp_day: 100 }, () => 0.999999);
    expect(r.atCap).toBe(true);
    expect(r.target).toBeLessThan(300);
    expect(r.target).toBeGreaterThanOrEqual(300 - Math.ceil(300 * 0.12));
  });

  it('never returns a negative target', () => {
    const r = computeDailyQuota({ ...control, ramp_base: 0, daily_limit: 0, ramp_day: 0 }, () => 0.5);
    expect(r.target).toBeGreaterThanOrEqual(0);
  });
});
