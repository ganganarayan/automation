/**
 * Video pipeline scheduling (pure, IST).
 *
 * Purpose:      Decide WHEN a funnel's daily video run happens and WHAT post
 *               datetime the resulting instance targets — without touching
 *               settings or the database, so it unit-tests like utils/
 *               instanceSpec and utils/scheduling (luxon only, no DATABASE_URL).
 * Responsibility: Pure date logic on Luxon; callers pass "now" (IST) for tests.
 * Dependencies: luxon, utils/scheduling (pure).
 *
 * Wake/sleep model: the external cron wakes the app ~just before a funnel's
 * generate_time, the app creates the instance (its work), then sleeps. A post
 * going out at publish_time is GENERATED THE RUN BEFORE — in the evening-generate
 * / morning-publish case, the day before — so an instance's scheduled_for is the
 * NEXT publish_time strictly ahead of "now", i.e. tomorrow's publish time when
 * generating the day before.
 */
import { DateTime } from 'luxon';
import { publishAtIst } from './scheduling.js';

const ZONE = 'Asia/Kolkata';

/**
 * Parse a "generate_days" CSV ("1,3,5", blank = every day) into weekday-number
 * strings (1 = Mon .. 7 = Sun), matching Luxon's `weekday`.
 */
export function parseGenerateDays(generateDays) {
  return String(generateDays || '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
}

/** True when today's IST weekday runs this funnel (blank list = every day). */
export function runsToday(generateDays, now = DateTime.now().setZone(ZONE)) {
  const days = parseGenerateDays(generateDays);
  if (!days.length) return true;
  return days.includes(String(now.setZone(ZONE).weekday));
}

/** Parse "HH:mm" into [hour, minute], tolerant of blanks / garbage. */
function parseHm(timeStr, fallbackH, fallbackM) {
  const [h, m] = String(timeStr || '').split(':').map((x) => parseInt(x, 10));
  return [Number.isFinite(h) ? h : fallbackH, Number.isFinite(m) ? m : fallbackM];
}

/**
 * Whether this funnel's generate run is due at "now". Due when the funnel runs
 * today (generate_days) AND its generate_time falls within
 * [now - backMin, now + forwardMin] — the same symmetric window the funnel-poster
 * cron uses, so a ping arriving ~10 min early still catches it and a late run
 * doesn't miss it, without touching funnels scheduled far away.
 */
export function isRunDue({
  generateTime,
  generateDays,
  now = DateTime.now().setZone(ZONE),
  forwardMin = 15,
  backMin = 15,
}) {
  const n = now.setZone(ZONE);
  if (!runsToday(generateDays, n)) return false;
  const [h, m] = parseHm(generateTime, 22, 0);
  const target = n.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  const diffMin = target.diff(n, 'minutes').minutes;
  return diffMin <= forwardMin && diffMin >= -backMin;
}

/**
 * The target POST datetime to store as instances.scheduled_for: the next
 * publish_time strictly ahead of "now" (today if still ahead, else tomorrow).
 * Generating in the evening for an early-morning publish therefore targets
 * tomorrow, as the wake/sleep model requires.
 */
export function targetPostAt({ publishTime, now = DateTime.now().setZone(ZONE) }) {
  return publishAtIst(publishTime || '08:02', now.setZone(ZONE));
}

/** IST date key (yyyy-MM-dd) of a target datetime — the idempotency key part. */
export function postDateKey(dt) {
  return dt.setZone(ZONE).toFormat('yyyy-MM-dd');
}

/**
 * One-call decision for a resolved funnel: whether a run is due now, the target
 * post datetime for the instance (Luxon DateTime, IST), and its IST date key
 * (for the funnel + date idempotency guard).
 */
export function decideFunnelRun({
  generateTime,
  generateDays,
  publishTime,
  now = DateTime.now().setZone(ZONE),
  forwardMin = 15,
  backMin = 15,
}) {
  const n = now.setZone(ZONE);
  const scheduledFor = targetPostAt({ publishTime, now: n });
  return {
    due: isRunDue({ generateTime, generateDays, now: n, forwardMin, backMin }),
    scheduledFor,
    dateKey: postDateKey(scheduledFor),
  };
}

export { ZONE };
export default {
  parseGenerateDays,
  runsToday,
  isRunDue,
  targetPostAt,
  postDateKey,
  decideFunnelRun,
  ZONE,
};
