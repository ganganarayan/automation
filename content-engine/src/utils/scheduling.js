/**
 * Scheduling rules (IST).
 *
 * Purpose:      Compute the Post-for-Me `scheduled_at` timestamp for each brand's
 *               publishing rules, deterministically and testably.
 * Responsibility: Pure date logic on Luxon; callers pass "now" for tests.
 * Dependencies: luxon.
 */
import { DateTime } from 'luxon';

const ZONE = 'Asia/Kolkata';

const at = (base, hour, minute) => base.set({ hour, minute, second: 0, millisecond: 0 });

/**
 * Gita image rule:
 *  - if current hour >= 21 -> tomorrow 08:02
 *  - else if hour < 8      -> today 08:02
 *  - else                  -> now + 5 minutes
 * @param {DateTime} [now]
 * @returns {DateTime}
 */
export function gitaImageScheduledAt(now = DateTime.now().setZone(ZONE)) {
  const n = now.setZone(ZONE);
  if (n.hour >= 21) return at(n.plus({ days: 1 }), 8, 2);
  if (n.hour < 8) return at(n, 8, 2);
  return n.plus({ minutes: 5 });
}

/**
 * VidaPulse image rule: today 10:00 IST if now is before 10:00, else tomorrow.
 */
export function vidapulseImageScheduledAt(now = DateTime.now().setZone(ZONE)) {
  const n = now.setZone(ZONE);
  const tenToday = at(n, 10, 0);
  return n < tenToday ? tenToday : at(n.plus({ days: 1 }), 10, 0);
}

/**
 * Gita video rule: today 10:02 IST, or now + 1 minute if already past 10:02.
 */
export function gitaVideoScheduledAt(now = DateTime.now().setZone(ZONE)) {
  const n = now.setZone(ZONE);
  const target = at(n, 10, 2);
  return n <= target ? target : n.plus({ minutes: 1 });
}

/**
 * Simple video (reels) rule: today 11:00 IST, or tomorrow 11:00 if past.
 */
export function simpleVideoScheduledAt(now = DateTime.now().setZone(ZONE)) {
  const n = now.setZone(ZONE);
  const target = at(n, 11, 0);
  return n <= target ? target : at(n.plus({ days: 1 }), 11, 0);
}

export { ZONE };
export default {
  gitaImageScheduledAt,
  vidapulseImageScheduledAt,
  gitaVideoScheduledAt,
  simpleVideoScheduledAt,
};
