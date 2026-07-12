import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyRazorpaySignature } from '../src/utils/signature.js';

const secret = 'whsec_test';
const body = JSON.stringify({ event: 'payment.captured', payload: {} });
const goodSig = createHmac('sha256', secret).update(body).digest('hex');

describe('verifyRazorpaySignature', () => {
  it('accepts a correct signature', () => {
    expect(verifyRazorpaySignature(body, goodSig, secret)).toBe(true);
  });
  it('accepts when given a Buffer body', () => {
    expect(verifyRazorpaySignature(Buffer.from(body), goodSig, secret)).toBe(true);
  });
  it('rejects a tampered body', () => {
    expect(verifyRazorpaySignature(body + 'x', goodSig, secret)).toBe(false);
  });
  it('rejects a wrong secret', () => {
    expect(verifyRazorpaySignature(body, goodSig, 'nope')).toBe(false);
  });
  it('rejects when signature or secret is missing', () => {
    expect(verifyRazorpaySignature(body, '', secret)).toBe(false);
    expect(verifyRazorpaySignature(body, goodSig, '')).toBe(false);
  });
});
