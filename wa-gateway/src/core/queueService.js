/**
 * Queue service (WhatsApp send queue abstraction).
 *
 * Purpose:      Expose queue operations to business modules so they never touch
 *               queue tables directly. The backing store (Postgres today) could
 *               be swapped for Redis/SQS/RabbitMQ without changing callers.
 * Responsibility:
 *               - enqueue / dequeue (next) / retry / purge / delay-gate ops.
 * Dependencies: waQueueRepository, waGateRepository.
 */
import * as waQueue from '../repositories/waQueueRepository.js';
import * as waGate from '../repositories/waGateRepository.js';

/** Enqueue a message for throttled delivery. */
export function enqueue({ tenantId, instance, number, message }) {
  return waQueue.enqueue({ tenantId, instance, number, message });
}

/** Peek the next deliverable message for an instance. */
export function next({ tenantId, instance }) {
  return waQueue.nextQueued({ tenantId, instance });
}

/** All (tenant, instance) pairs with queued work. */
export function pending() {
  return waQueue.instancesWithQueued();
}

/** Mark a message delivered. */
export function markSent(id) {
  return waQueue.markSent(id);
}

/** Record a failed attempt (retries until maxAttempts, then FAILED). */
export function retry(id, maxAttempts) {
  return waQueue.recordFailure(id, maxAttempts);
}

/** Delete messages by status. */
export function purge({ tenantId, status }) {
  return waQueue.purge({ tenantId, status });
}

/** Queue depth by status. */
export function depth({ tenantId }) {
  return waQueue.depth({ tenantId });
}

/**
 * Try to open the per-instance gate for exactly one send this window.
 * @returns {Promise<boolean>} true if the caller may send now.
 */
export function claimGate({ tenantId, instance, nowMs, gapMs }) {
  return waGate.tryClaim({ tenantId, instance, nowMs, gapMs });
}

/** Roll the gate back (send could not proceed; don't waste the gap). */
export function releaseGate({ tenantId, instance, nowMs }) {
  return waGate.release({ tenantId, instance, nowMs });
}

export default { enqueue, next, pending, markSent, retry, purge, depth, claimGate, releaseGate };
