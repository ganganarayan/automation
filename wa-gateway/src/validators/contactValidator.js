/**
 * Contact validator for Delay Relay intake.
 *
 * Purpose:      Decide which channels (email / whatsapp) a lead qualifies for,
 *               rejecting fake or disposable contacts before they enter the drip.
 * Responsibility: Pure validation; no I/O. The live MX check happens later at
 *               send time, not here.
 * Dependencies: none.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Dummy local-parts that indicate a junk email.
const DUMMY_LOCALS = new Set([
  'test', 'tests', 'testing', 'abc', 'xyz', 'demo', 'admin', 'user', 'example',
  'sample', 'none', 'na', 'null', 'nobody', 'noone', 'fake', 'asdf', 'qwerty',
  'temp', 'dummy', 'foo', 'bar', 'baz',
]);

// Configurable disposable-email domains (~26).
export const DEFAULT_DISPOSABLE_DOMAINS = [
  'mailinator.com', 'yopmail.com', 'temp-mail.org', 'tempmail.com', 'guerrillamail.com',
  '10minutemail.com', 'trashmail.com', 'getnada.com', 'dispostable.com', 'fakeinbox.com',
  'maildrop.cc', 'throwawaymail.com', 'mytemp.email', 'sharklasers.com', 'grr.la',
  'guerrillamailblock.com', 'spam4.me', 'mailnesia.com', 'mohmal.com', 'emailondeck.com',
  'moakt.com', 'tempinbox.com', 'mintemail.com', 'mailcatch.com', 'inboxbear.com',
  'spamgourmet.com',
];

/**
 * @param {object} contact - { name, email, phone }
 * @param {object} [opts]
 * @param {string[]} [opts.disposableDomains]
 * @returns {{ channels: string[], status: 'pending'|'invalid', invalidReason: string|null,
 *            emailValid: boolean, phoneValid: boolean }}
 */
export function validateContact(contact, opts = {}) {
  const disposable = new Set(
    (opts.disposableDomains || DEFAULT_DISPOSABLE_DOMAINS).map((d) => d.toLowerCase()),
  );

  const email = (contact.email || '').trim();
  const phone = (contact.phone || '').replace(/\D+/g, '');

  const emailResult = validateEmail(email, disposable);
  const phoneResult = validatePhone(phone);

  const channels = [];
  if (emailResult.valid) channels.push('email');
  if (phoneResult.valid) channels.push('whatsapp');

  if (channels.length > 0) {
    return {
      channels,
      status: 'pending',
      invalidReason: null,
      emailValid: emailResult.valid,
      phoneValid: phoneResult.valid,
    };
  }

  const reasons = [emailResult.reason, phoneResult.reason].filter(Boolean);
  return {
    channels: [],
    status: 'invalid',
    invalidReason: reasons.join('; ') || 'no valid channel',
    emailValid: false,
    phoneValid: false,
  };
}

/** @returns {{ valid: boolean, reason: string|null }} */
export function validateEmail(email, disposable) {
  if (!email) return { valid: false, reason: 'email missing' };
  if (!EMAIL_RE.test(email)) return { valid: false, reason: 'email malformed' };

  const [local, domain] = email.toLowerCase().split('@');

  if (DUMMY_LOCALS.has(local)) return { valid: false, reason: 'email dummy local-part' };
  if (/(.)\1{3,}/.test(local)) return { valid: false, reason: 'email repeated chars' };
  if (disposable.has(domain)) return { valid: false, reason: 'email disposable domain' };

  return { valid: true, reason: null };
}

/**
 * Phone is valid when it has 10-13 digits, more than 2 distinct digits, and is
 * not ">= 80% sequential" (e.g. 1234567890).
 * @returns {{ valid: boolean, reason: string|null }}
 */
export function validatePhone(phone) {
  if (!phone) return { valid: false, reason: 'phone missing' };
  if (phone.length < 10 || phone.length > 13) return { valid: false, reason: 'phone length' };

  const uniqueDigits = new Set(phone.split('')).size;
  if (uniqueDigits <= 2) return { valid: false, reason: 'phone too few unique digits' };

  if (sequentialRatio(phone) >= 0.8) return { valid: false, reason: 'phone sequential' };

  return { valid: true, reason: null };
}

/** Fraction of adjacent digit pairs that step by +1 or -1. */
function sequentialRatio(digits) {
  if (digits.length < 2) return 0;
  let seq = 0;
  for (let i = 1; i < digits.length; i += 1) {
    const diff = Number(digits[i]) - Number(digits[i - 1]);
    if (diff === 1 || diff === -1) seq += 1;
  }
  return seq / (digits.length - 1);
}

export default { validateContact, validateEmail, validatePhone, DEFAULT_DISPOSABLE_DOMAINS };
