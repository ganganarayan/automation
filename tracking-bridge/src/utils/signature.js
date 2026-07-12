/**
 * Razorpay webhook signature verification.
 *
 * Purpose:      Verify the x-razorpay-signature header against the raw request
 *               body using HMAC-SHA256.
 * Responsibility: Pure crypto; no I/O. Constant-time comparison.
 * Dependencies: crypto.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * @param {Buffer|string} rawBody - the exact bytes received
 * @param {string} signature      - hex signature from the header
 * @param {string} secret         - RAZORPAY_WEBHOOK_SECRET
 * @returns {boolean}
 */
export function verifyRazorpaySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8'))
    .digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default { verifyRazorpaySignature };
