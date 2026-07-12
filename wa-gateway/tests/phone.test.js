import { describe, it, expect } from 'vitest';
import { normalizePhone, cleanRelayNumber, hasMinDigits } from '../src/utils/phone.js';

describe('normalizePhone', () => {
  it('prefixes 91 for 10-digit numbers', () => {
    expect(normalizePhone('9876543210')).toBe('919876543210');
  });
  it('converts a leading 0 + 10 digits to 91', () => {
    expect(normalizePhone('09876543210')).toBe('919876543210');
  });
  it('leaves an already-prefixed 12-digit number unchanged', () => {
    expect(normalizePhone('919876543210')).toBe('919876543210');
  });
  it('strips spaces, dashes and plus signs', () => {
    expect(normalizePhone('+91 98765-43210')).toBe('919876543210');
  });
  it('returns empty for nullish input', () => {
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });
});

describe('cleanRelayNumber', () => {
  it('strips leading zeros then normalizes', () => {
    expect(cleanRelayNumber('009876543210')).toBe('919876543210');
  });
});

describe('hasMinDigits', () => {
  it('checks minimum length', () => {
    expect(hasMinDigits('919876543210', 12)).toBe(true);
    expect(hasMinDigits('9876543210', 12)).toBe(false);
  });
});
