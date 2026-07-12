/**
 * Generic managed-job runner.
 *
 * Purpose:      Execute asynchronous work durably, so modules don't each build
 *               their own retry loops. A job is persisted, claimed atomically,
 *               executed by a registered handler, and marked done/failed.
 * Responsibility:
 *               - Handler registry keyed by job type.
 *               - A polling loop that claims due jobs and runs them.
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

/** Enqueue a job for later execution. */
export function enqueueJob({ tenantId, type, payload, runAt }) {
  if (!handlers.has(type)) {
    logger.warn({ type }, 'enqueuing job with no registered handler');
  }
  return jobRepo.create({ tenantId, type, payload, runAt });
}

let timer = null;

/** Start the polling loop. */
export function start({ intervalMs = 5000, batch = 5 } = {}) {
  if (timer) return;
  const types = [...handlers.keys()];
  if (types.length === 0) {
    logger.info('job runner started with no handlers registered');
  }
  const tick = async () => {
    try {
      if (handlers.size === 0) return;
      const jobs = await jobRepo.claimDue({ types: [...handlers.keys()], limit: batch });
      for (const job of jobs) await runOne(job);
    } catch (err) {
      logger.error({ err: err.message }, 'job runner tick failed');
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  logger.info({ intervalMs, handlers: [...handlers.keys()] }, 'job runner started');
}

/** Stop the loop. */
export function stop() {
  if (timer) clearInterval(timer);
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
