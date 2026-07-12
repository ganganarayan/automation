/**
 * Phone number utilities.
 *
 * Purpose:      Normalize Indian phone numbers to the digits-only, country-code
 *               form Evolution expects.
 * Responsibility: Pure string transformation; no I/O.
 * Dependencies: none.
 */

/**
 * Normalize a phone number to digits with an Indian country code.
 *  - strips all non-digits
 *  - 10 digits            -> prefix "91"
 *  - 11 digits start "0"  -> "91" + last 10
 *  - 12 digits start "91" -> unchanged
 *  - otherwise            -> digits as-is (caller decides validity)
 *
 * @param {string|number} input
 * @returns {string} digits only
 */
export function normalizePhone(input) {
  if (input === undefined || input === null) return '';
  const digits = String(input).replace(/\D+/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

/**
 * Stricter cleaner for the raw relays: strip leading zeros first, then apply the
 * standard normalization. Used where numbers may arrive as "091...".
 */
export function cleanRelayNumber(input) {
  if (input === undefined || input === null) return '';
  const stripped = String(input).replace(/\D+/g, '').replace(/^0+/, '');
  return normalizePhone(stripped);
}

/** A normalized number is sendable when it has at least `min` digits. */
export function hasMinDigits(number, min = 11) {
  return typeof number === 'string' && number.length >= min;
}

export default { normalizePhone, cleanRelayNumber, hasMinDigits };
