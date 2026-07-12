/**
 * Send service.
 *
 * Purpose:      Normalize a number and enqueue a message through the throttle.
 *               The single choke point other modules use to put work on the
 *               queue, so normalization/validation rules live in one place.
 * Responsibility: normalize -> validate min length -> enqueue (or drop).
 * Dependencies: queueService, phone utils.
 */
import * as queue from '../core/queueService.js';
import { normalizePhone, hasMinDigits } from '../utils/phone.js';

/**
 * Enqueue a message. Returns the queued row, or null if dropped (empty message
 * or too-short number).
 * @param {object} args - { tenantId, instance, number, message, minDigits }
 */
export async function enqueueMessage({ tenantId = 'default', instance, number, message, minDigits = 11 }) {
  const normalized = normalizePhone(number);
  const text = (message || '').trim();
  if (!text || !hasMinDigits(normalized, minDigits)) return null;
  return queue.enqueue({ tenantId, instance, number: normalized, message: text });
}

export default { enqueueMessage };
