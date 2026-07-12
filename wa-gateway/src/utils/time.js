/**
 * Time utilities (IST-aware).
 *
 * Purpose:      All time math for the service, pinned to Asia/Kolkata, so cron
 *               windows and gaps behave regardless of the host clock's zone.
 * Responsibility: Pure date logic built on Luxon.
 * Dependencies: luxon, settings (timezone).
 */
import { DateTime } from 'luxon';
import { settings } from '../settings/index.js';

const ZONE = settings.tz || 'Asia/Kolkata';

/** Current time in the service timezone. */
export function nowIst() {
  return DateTime.now().setZone(ZONE);
}

/** The current hour (0-23) in IST. */
export function currentHourIst() {
  return nowIst().hour;
}

/**
 * True when the current IST hour is within [startHour, endHour).
 * endHour of 24 means "up to midnight".
 */
export function isWithinWindow(startHour, endHour, at = nowIst()) {
  const hour = at.hour;
  return hour >= startHour && hour < endHour;
}

/** Epoch milliseconds now. */
export function epochMs() {
  return Date.now();
}

/** A random integer in [minSeconds, maxSeconds] converted to milliseconds. */
export function randomGapMs(minSeconds, maxSeconds) {
  const lo = Math.min(minSeconds, maxSeconds);
  const hi = Math.max(minSeconds, maxSeconds);
  const seconds = lo + Math.random() * (hi - lo);
  return Math.round(seconds * 1000);
}

/** ISO string in IST for human-readable alerts. */
export function isoIst(at = nowIst()) {
  return at.toISO();
}

/** Today's date key (yyyy-MM-dd) in IST. */
export function todayKeyIst(at = nowIst()) {
  return at.toFormat('yyyy-MM-dd');
}

export { ZONE };
export default { nowIst, currentHourIst, isWithinWindow, epochMs, randomGapMs, isoIst, todayKeyIst, ZONE };
