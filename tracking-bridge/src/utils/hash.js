/**
 * Hashing helpers for Meta CAPI.
 *
 * Purpose:      Normalize and SHA-256 hash PII exactly as Meta expects
 *               (lowercase, trimmed) and normalize Indian phone numbers.
 * Responsibility: Pure functions.
 * Dependencies: crypto.
 */
import { createHash } from 'node:crypto';

/** Lowercase + trim then SHA-256 hex. Returns null for empty input. */
export function hashNormalized(value) {
  if (value === undefined || value === null) return null;
  const norm = String(value).trim().toLowerCase();
  if (!norm) return null;
  return createHash('sha256').update(norm).digest('hex');
}

/** Digits-only; 10-digit numbers get a leading "91". */
export function normalizePhoneDigits(value) {
  if (value === undefined || value === null) return '';
  const digits = String(value).replace(/\D+/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

/** Hash a phone number after normalization. */
export function hashPhone(value) {
  const digits = normalizePhoneDigits(value);
  return digits ? hashNormalized(digits) : null;
}

/** Distinct, non-null hashed values from a list of raw inputs. */
export function hashedSet(values, hasher) {
  const out = new Set();
  for (const v of values) {
    const h = hasher(v);
    if (h) out.add(h);
  }
  return [...out];
}

export default { hashNormalized, normalizePhoneDigits, hashPhone, hashedSet };
