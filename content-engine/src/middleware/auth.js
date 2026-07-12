/**
 * Auth guards.
 *
 * Purpose:      Protect internal and admin endpoints with shared-secret headers.
 * Responsibility:
 *               - requireInternalKey: X-Internal-Key must equal INTERNAL_API_KEY.
 *               - requireAdminKey:    X-Admin-Key must equal ADMIN_KEY.
 * Dependencies: settings, errors.
 *
 * Uses a length-safe constant-time compare to avoid trivial timing leaks.
 */
import { timingSafeEqual } from 'node:crypto';
import { settings } from '../settings/index.js';
import { AuthenticationError } from '../core/errors.js';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/** Guard requiring a valid internal API key. */
export function requireInternalKey(req, _res, next) {
  const expected = settings.auth.internalApiKey;
  if (!expected || !safeEqual(req.headers['x-internal-key'], expected)) {
    return next(new AuthenticationError('Invalid internal key'));
  }
  next();
}

/** Guard requiring a valid admin key. */
export function requireAdminKey(req, _res, next) {
  const expected = settings.auth.adminKey;
  if (!expected || !safeEqual(req.headers['x-admin-key'], expected)) {
    return next(new AuthenticationError('Invalid admin key'));
  }
  next();
}

export default { requireInternalKey, requireAdminKey };
