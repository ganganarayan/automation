/**
 * Heartbeat: keep the service awake while real work is running.
 *
 * Purpose:      Railway's App Sleeping stops a service ~5–10 minutes after it
 *               last sent an outbound packet. A long ffmpeg encode or a wait
 *               on a video provider can be that quiet, so while any job holds
 *               the heartbeat we send a tiny `SELECT 1` every minute. With no
 *               holds the app is silent and may sleep; webhooks, approval
 *               links and the GitHub cron wake it again.
 * Responsibility: reference-counted holds + one interval.
 * Dependencies: core/db, logger.
 */
import { ping } from './db.js';
import { logger } from './logger.js';

const BEAT_MS = 60 * 1000;
const holds = new Map(); // label -> count
let timer = null;
const idleListeners = [];

/** Call fn each time the last hold is released (the app is about to fall quiet). */
export function onIdle(fn) {
  idleListeners.push(fn);
}

function beat() {
  ping().catch((err) => logger.warn({ err: err.message }, 'heartbeat ping failed'));
}

/** Hold the app awake until the returned release() is called (safe to call twice). */
export function hold(label = 'job') {
  holds.set(label, (holds.get(label) || 0) + 1);
  if (!timer) {
    timer = setInterval(beat, BEAT_MS);
    logger.info({ label }, 'heartbeat on');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (holds.get(label) || 1) - 1;
    if (n > 0) holds.set(label, n); else holds.delete(label);
    if (!holds.size && timer) {
      clearInterval(timer);
      timer = null;
      logger.info('heartbeat off: the app may sleep');
      for (const fn of idleListeners) setImmediate(() => Promise.resolve().then(fn).catch((err) => logger.warn({ err: err.message }, 'idle listener failed')));
    }
  };
}

/** Run fn while holding the heartbeat. */
export async function during(label, fn) {
  const release = hold(label);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** What is holding the app awake right now (for /api/version-style checks). */
export function active() {
  return Object.fromEntries(holds);
}

export default { hold, during, active, onIdle };
