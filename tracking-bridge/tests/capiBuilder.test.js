import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildPurchaseEvent, extractPurchase, reconstructFbc } from '../src/services/capiBuilder.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const config = { contentName: 'Consultation', eventSourceUrl: 'https://applygita.com' };

describe('extractPurchase', () => {
  it('pulls email/phone/amount/ids/notes from a payment.captured payload', () => {
    const payload = {
      event: 'payment.captured',
      payload: { payment: { entity: {
        id: 'pay_1', order_id: 'order_1', email: 'A@B.com', contact: '9876543210', amount: 149900,
        notes: { fbp: 'fbp1' },
      } } },
    };
    const p = extractPurchase(payload);
    expect(p.paymentId).toBe('pay_1');
    expect(p.amount).toBe(1499);
    expect(p.email).toBe('A@B.com');
    expect(p.notes.fbp).toBe('fbp1');
  });
});

describe('reconstructFbc', () => {
  it('builds fb.1.{ts}.{fbclid}', () => {
    expect(reconstructFbc('abc123', 1_700_000_000_000)).toBe('fb.1.1700000000.abc123');
  });
  it('returns null without an fbclid', () => {
    expect(reconstructFbc('')).toBeNull();
  });
});

describe('buildPurchaseEvent', () => {
  const purchase = { email: 'Buyer@Example.com', phone: '9876543210', amount: 1499, paymentId: 'pay_9', notes: {} };

  it('hashes email and phone (lowercased/normalized) into arrays', () => {
    const { event } = buildPurchaseEvent({ purchase, config });
    expect(event.user_data.em).toEqual([sha('buyer@example.com')]);
    expect(event.user_data.ph).toEqual([sha('919876543210')]);
  });

  it('uses payment_id as event_id for dedup and sets Purchase/INR', () => {
    const { event } = buildPurchaseEvent({ purchase, config });
    expect(event.event_id).toBe('pay_9');
    expect(event.event_name).toBe('Purchase');
    expect(event.custom_data.currency).toBe('INR');
    expect(event.custom_data.value).toBe(1499);
  });

  it('prefers enrichment fbc over reconstruction over notes', () => {
    const withFbc = buildPurchaseEvent({ purchase, enrichment: { fbc: 'ENR', fbclid: 'x' }, config });
    expect(withFbc.event.user_data.fbc).toBe('ENR');

    const reconstructed = buildPurchaseEvent({
      purchase: { ...purchase, notes: { fbc: 'NOTE' } },
      enrichment: { fbclid: 'clickid' },
      config,
      nowMs: 1_700_000_000_000,
    });
    expect(reconstructed.event.user_data.fbc).toBe('fb.1.1700000000.clickid');

    const fromNotes = buildPurchaseEvent({ purchase: { ...purchase, notes: { fbc: 'NOTE' } }, config });
    expect(fromNotes.event.user_data.fbc).toBe('NOTE');
  });

  it('falls back to notes for ip/ua/fbp', () => {
    const { event } = buildPurchaseEvent({
      purchase: { ...purchase, notes: { client_ip: '1.2.3.4', client_ua: 'UA', fbp: 'FBP' } },
      config,
    });
    expect(event.user_data.client_ip_address).toBe('1.2.3.4');
    expect(event.user_data.client_user_agent).toBe('UA');
    expect(event.user_data.fbp).toBe('FBP');
  });

  it('merges distinct emails/phones from both sources', () => {
    const { event, matchSignals } = buildPurchaseEvent({
      purchase,
      enrichment: { found: true, email: 'other@example.com' },
      config,
    });
    expect(event.user_data.em).toHaveLength(2);
    expect(matchSignals.assess360).toBe(true);
  });
});
