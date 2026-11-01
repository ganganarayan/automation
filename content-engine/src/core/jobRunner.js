/**
 * Generic managed-job runner.
 *
 * Purpose:      Execute asynchronous work durably, so modules don't each build
 *               their own retry loops. A job is persisted, claimed atomically,
 *               executed by a registered handler, and marked done/failed.
 * Responsibility:
 *               - Handler registry keyed by job type.
 *               - A loop that claims due jobs and runs them. It only polls
 *                 while there is work: when the queue is empty it sleeps until
 *                 the next job's time, or until enqueueJob wakes it — so an
 *                 idle app sends no traffic and Railway can put it to sleep.
 *               - Retry with backoff up to a per-type max attempts.
 * Dependencies: jobRepository, logger.
 */
import * as jobRepo from '../repositories/jobRepository.js';
import { logger } from './logger.js';

const handlers = new Map(); // type -> { handler, maxAttempts, backoffSeconds }

/**
 * Register a handler for a job type.
 * @param {string} type
 * @param {(job: object) => Promise<void>} handler
 * @param {object} [opts] - { maxAttempts, backoffSeconds }
 */
export function registerHandler(type, handler, opts = {}) {
  handlers.set(type, {
    handler,
    maxAttempts: opts.maxAttempts ?? 5,
    backoffSeconds: opts.backoffSeconds ?? 60,
  });
}

/** Enqueue a job for later execution (and wake the loop for it). */
export async function enqueueJob({ tenantId, type, payload, runAt }) {
  if (!handlers.has(type)) {
    logger.warn({ type }, 'enqueuing job with no registered handler');
  }
  const job = await jobRepo.create({ tenantId, type, payload, runAt });
  wake(runAt ? new Date(runAt) : new Date());
  return job;
}

const MAX_WAIT_MS = 24 * 60 * 60 * 1000; // setTimeout's own limit is ~24 days; re-check daily
let timer = null;
let timerAt = 0;
let running = false;
let started = false;
let opts = { intervalMs: 5000, batch: 5 };

/** Schedule the next tick for `at` unless one is already due sooner. */
function wake(at = new Date()) {
  if (!started) return;
  const when = Math.max(Date.now(), at.getTime());
  if (timer && timerAt <= when) return;
  if (timer) clearTimeout(timer);
  timerAt = when;
  timer = setTimeout(tick, Math.min(when - Date.now(), MAX_WAIT_MS));
  timer.unref?.();
}

async function tick() {
  timer = null;
  timerAt = 0;
  if (running || handlers.size === 0) return;
  running = true;
  const types = [...handlers.keys()];
  try {
    const jobs = await jobRepo.claimDue({ types, limit: opts.batch });
    for (const job of jobs) await runOne(job);
    if (jobs.length) {
      wake(new Date(Date.now() + opts.intervalMs));
    } else {
      const next = await jobRepo.nextDue({ types });
      if (next) wake(next);
    }
  } catch (err) {
    logger.error({ err: err.message }, 'job runner tick failed');
    wake(new Date(Date.now() + opts.intervalMs * 6));
  } finally {
    running = false;
  }
}

/** Start the loop: one check now, then only when there is work. */
export function start({ intervalMs = 5000, batch = 5 } = {}) {
  if (started) return;
  started = true;
  opts = { intervalMs, batch };
  if (handlers.size === 0) {
    logger.info('job runner started with no handlers registered');
  }
  wake();
  logger.info({ intervalMs, handlers: [...handlers.keys()] }, 'job runner started (idle when the queue is empty)');
}

/** Stop the loop. */
export function stop() {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

async function runOne(job) {
  const entry = handlers.get(job.type);
  const log = logger.child({ module: 'jobRunner', job_id: job.id, type: job.type, tenant_id: job.tenant_id });
  if (!entry) {
    await jobRepo.markFailed(job.id, { error: `no handler for ${job.type}`, retry: false });
    return;
  }
  try {
    await entry.handler(job);
    await jobRepo.markDone(job.id);
    log.info('job done');
  } catch (err) {
    const canRetry = job.attempts < entry.maxAttempts && err?.retryable !== false;
    await jobRepo.markFailed(job.id, {
      error: err?.message || String(err),
      retry: canRetry,
      backoffSeconds: entry.backoffSeconds,
    });
    log.warn({ err: err?.message, attempts: job.attempts, retry: canRetry }, 'job failed');
  }
}

export default { registerHandler, enqueueJob, start, stop };
