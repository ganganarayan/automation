/**
 * Delay Relay ramp calculator.
 *
 * Purpose:      Compute today's sending quota for an account using a warm-up
 *               ramp so a fresh number is not blasted on day one.
 * Responsibility: Pure arithmetic; no I/O.
 * Dependencies: none.
 */

/**
 * @typedef {object} RelayControl
 * @property {number} daily_limit
 * @property {number} ramp_base
 * @property {number} ramp_step
 * @property {number} warmup_days
 * @property {number} ramp_day   - days already ramped
 */

/**
 * Compute the quota for the next day.
 *
 *  - day = ramp_day + 1
 *  - during warmup_days: target = ramp_base
 *  - after warmup:       target = ramp_base + (day - warmup_days) * ramp_step
 *  - capped at daily_limit
 *  - at the cap, shave a random 0-12% so volume is not a flat line
 *  - below the cap, add small positive jitter (0-8%)
 *
 * @param {RelayControl} control
 * @param {() => number} [rand] - injectable RNG for deterministic tests
 * @returns {{ day: number, target: number, atCap: boolean }}
 */
export function computeDailyQuota(control, rand = Math.random) {
  const dailyLimit = num(control.daily_limit, 300);
  const rampBase = num(control.ramp_base, 30);
  const rampStep = num(control.ramp_step, 30);
  const warmupDays = num(control.warmup_days, 5);
  const rampDay = num(control.ramp_day, 0);

  const day = rampDay + 1;

  let target;
  if (day <= warmupDays) {
    target = rampBase;
  } else {
    target = rampBase + (day - warmupDays) * rampStep;
  }

  let atCap = false;
  if (target >= dailyLimit) {
    atCap = true;
    const shave = Math.floor(dailyLimit * (rand() * 0.12));
    target = dailyLimit - shave;
  } else {
    const jitter = Math.floor(target * (rand() * 0.08));
    target = Math.min(target + jitter, dailyLimit);
  }

  return { day, target: Math.max(0, target), atCap };
}

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export default { computeDailyQuota };
