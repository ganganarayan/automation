import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { TEST_PLANS, rankOf, testQuote, rowActions, orderSigOk, billingMail } from '../src/utils/billingTestSpec.js';
import { planKey, readPlanKey } from '../src/utils/billingSpec.js';
import { planBody, testPayments } from '../src/utils/planPage.js';

describe('Rs 1 test payments', () => {
  it('lists every buyable plan cheapest first, without Custom', () => {
    expect(TEST_PLANS).toEqual(['lite', 'solo', 'starter', 'brand', 'growth', 'agency']);
    expect(rankOf('custom')).toBe(-1);
  });

  it('charges one rupee, and the plan key still names the plan', () => {
    const q = testQuote('growth');
    expect(q).toMatchObject({ currency: 'INR', amount: 100, total: 1, gst: 0, bill: 'mo' });
    expect(readPlanKey(planKey(q))).toMatchObject({ plan: 'growth', units: 1, users: 0 });
    expect(() => testQuote('custom')).toThrow();
  });

  it('offers upgrade above, downgrade below and cancel on the current plan', () => {
    const ws = { plan: 'starter', ended: false };
    expect(rowActions('growth', ws)).toEqual({ upgrade: true, downgrade: false, cancel: false });
    expect(rowActions('lite', ws)).toEqual({ upgrade: false, downgrade: true, cancel: false });
    expect(rowActions('starter', ws)).toEqual({ upgrade: false, downgrade: false, cancel: true });
    expect(rowActions('growth', { plan: 'starter', ended: true })).toEqual({ upgrade: false, downgrade: false, cancel: false });
    expect(rowActions('growth', null)).toEqual({ upgrade: false, downgrade: false, cancel: false });
  });

  it('checks the order signature', () => {
    const secret = 's3cret';
    const signature = createHmac('sha256', secret).update('order_1|pay_1').digest('hex');
    expect(orderSigOk({ orderId: 'order_1', paymentId: 'pay_1', signature, secret })).toBe(true);
    expect(orderSigOk({ orderId: 'order_1', paymentId: 'pay_2', signature, secret })).toBe(false);
  });

  it('writes each buyer email with the sign-in link and DD-MM-YYYY date as given', () => {
    const w = billingMail({ kind: 'welcome', plan: 'lite', workspace: 'test-lite', email: 'a@b.co', tempPassword: 'pw', base: 'https://app.example.com/', until: '12-12-2026', test: true });
    expect(w.subject).toContain('ready');
    expect(w.text).toContain('https://app.example.com/api/v1/admin/login');
    expect(w.text).toContain('pw');
    expect(w.text).toContain('12-12-2026');
    expect(billingMail({ kind: 'upgraded', plan: 'growth', from: 'lite', workspace: 'w' }).text).toContain('open now');
    expect(billingMail({ kind: 'downgraded', plan: 'lite', from: 'growth', workspace: 'w' }).text).toContain('switched off');
    expect(billingMail({ kind: 'cancelled', plan: 'lite', workspace: 'w', test: true }).text).toContain('locked');
    for (const k of ['welcome', 'upgraded', 'downgraded', 'cancelled']) expect(JSON.stringify(billingMail({ kind: k, plan: 'lite' }))).not.toContain(String.fromCharCode(0x2014));
  });

  it('shows one row per plan with all four buttons, for the owner only', () => {
    const html = testPayments([{ tenantId: 't1', name: 'Test lite', email: 'a@b.co', plan: 'lite', ended: false, until: '12-12-2026' }]);
    expect((html.match(/<tr data-plan=/g) || []).length).toBe(6);
    for (const b of ['Subscribe ₹1', 'Upgrade ₹1', 'Downgrade', 'Cancel']) expect(html).toContain(b);
    const owner = planBody({ superAdmin: true, pay: { keyId: '', tests: [] }, origin: 'https://x' });
    expect(owner).toContain('test-payments');
    expect(planBody({ superAdmin: false })).not.toContain('test-payments');
  });
});
