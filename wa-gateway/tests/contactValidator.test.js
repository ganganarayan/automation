import { describe, it, expect } from 'vitest';
import { validateContact, validateEmail, validatePhone } from '../src/validators/contactValidator.js';

describe('validatePhone', () => {
  it('accepts a normal 12-digit number', () => {
    expect(validatePhone('919632581470').valid).toBe(true);
  });
  it('rejects too-short numbers', () => {
    expect(validatePhone('12345').valid).toBe(false);
  });
  it('rejects numbers with <= 2 unique digits', () => {
    expect(validatePhone('1111111111').valid).toBe(false);
  });
  it('rejects highly sequential numbers', () => {
    expect(validatePhone('1234567890').valid).toBe(false);
  });
});

describe('validateEmail', () => {
  const disposable = new Set(['mailinator.com']);
  it('accepts a normal email', () => {
    expect(validateEmail('jane.doe@gmail.com', disposable).valid).toBe(true);
  });
  it('rejects dummy local parts', () => {
    expect(validateEmail('test@gmail.com', disposable).valid).toBe(false);
  });
  it('rejects disposable domains', () => {
    expect(validateEmail('someone@mailinator.com', disposable).valid).toBe(false);
  });
  it('rejects 4+ repeated chars in local part', () => {
    expect(validateEmail('aaaaa@gmail.com', disposable).valid).toBe(false);
  });
  it('rejects malformed addresses', () => {
    expect(validateEmail('not-an-email', disposable).valid).toBe(false);
  });
});

describe('validateContact', () => {
  it('returns pending with both channels when both are valid', () => {
    const r = validateContact({ name: 'Jane', email: 'jane@gmail.com', phone: '919632581470' });
    expect(r.status).toBe('pending');
    expect(r.channels).toEqual(['email', 'whatsapp']);
  });
  it('returns invalid with a reason when nothing is valid', () => {
    const r = validateContact({ name: 'x', email: 'test@x', phone: '111' });
    expect(r.status).toBe('invalid');
    expect(r.invalidReason).toBeTruthy();
  });
  it('keeps only the whatsapp channel when email is disposable', () => {
    const r = validateContact({ email: 'x@mailinator.com', phone: '919632581470' });
    expect(r.channels).toEqual(['whatsapp']);
  });
});
