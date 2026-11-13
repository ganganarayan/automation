import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { subscribeState, TEST_PLANS, rankOf, testQuote, testPrice, upgradePrice, stepsFrom, rowActions, orderSigOk, billingMail } from '../src/utils/billingTestSpec.js';
import { planKey, readPlanKey } from '../src/utils/billingSpec.js';
import { planBody, testPayments } from '../src/utils/planPage.js';

describe('Rs 1 test payments', () => {
  it('lists every buyable plan cheapest first, without Custom', () => {
    expect(TEST_PLANS).toEqual(['lite', 'solo', 'starter', 'brand', 'growth', 'agency']);
    expect(rankOf('custom')).toBe(-1);
  });

  it('charges each plan its own small price, and the plan key still names the plan', () => {
    expect(TEST_PLANS.map((p) => testQuote(p).amount)).toEqual([110, 120, 130, 140, 150, 160]);
    expect(testPrice('lite')).toBe('₹1.10');
    expect(upgradePrice('solo')).toBe('₹1.20');
    const q = testQuote('growth');
    expect(q).toMatchObject({ currency: 'INR', amount: 150, total: 1.5, gst: 0, bill: 'mo' });
    expect(readPlanKey(planKey(q))).toMatchObject({ plan: 'growth', units: 1, users: 0 });
    expect(() => testQuote('custom')).toThrow();
  });

  it('makes only the current plan row live: one step up, one step down, cancel', () => {
    const ws = { plan: 'starter', ended: false };
    expect(rowActions('starter', ws)).toEqual({ upgrade: true, downgrade: true, cancel: true });
    expect(rowActions('growth', ws)).toEqual({ upgrade: false, downgrade: false, cancel: false });
    expect(rowActions('lite', { plan: 'lite' })).toEqual({ upgrade: true, downgrade: false, cancel: true });
    expect(rowActions('agency', { plan: 'agency' })).toEqual({ upgrade: false, downgrade: true, cancel: true });
    expect(rowActions('starter', { plan: 'starter', ended: true })).toEqual({ upgrade: false, downgrade: false, cancel: false });
    expect(stepsFrom('lite')).toEqual({ up: 'solo', down: '' });
  });

  it('turns Subscribe off while paid, and into Pay again after a failed renewal', () => {
    const paid = { tenantId: 'a', plan: 'lite', ended: false, until: '15-12-2026' };
    const failed = { tenantId: 'b', plan: 'solo', ended: true, cancelledByOwner: false };
    const mine = { tenantId: 'c', plan: 'starter', ended: true, cancelledByOwner: true };
    expect(subscribeState('lite', [paid])).toEqual({ kind: 'paid', tenantId: 'a', until: '15-12-2026' });
    expect(subscribeState('solo', [failed])).toMatchObject({ kind: 'lapsed', tenantId: 'b' });
    expect(subscribeState('starter', [mine])).toEqual({ kind: 'new' });
    expect(subscribeState('growth', [paid, failed])).toEqual({ kind: 'new' });
    const html = testPayments([paid, failed]);
    expect(html).toContain('Paid till 15-12-2026');
    expect(html).toContain('Pay again ₹1.20');
    expect(html).toContain('Subscribe ₹1.30');
    expect(billingMail({ kind: 'renewed', plan: 'solo', workspace: 'w', until: '15-12-2026' }).text).toContain('15-12-2026');
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
    expect((html.match(/data-do="upgrade"/g) || []).length).toBe(5);
    expect((html.match(/data-do="downgrade"/g) || []).length).toBe(5);
    for (const b of ['Paid till 12-12-2026', 'Subscribe ₹1.20', 'Subscribe ₹1.60', 'Upgrade to Solo ₹1.20', 'Upgrade to Agency ₹1.60', 'Downgrade to Starter Lite', 'Downgrade to Growth', 'Cancel']) expect(html).toContain(b);
    const owner = planBody({ superAdmin: true, pay: { keyId: '', tests: [] }, origin: 'https://x' });
    expect(owner).toContain('test-payments');
    expect(planBody({ superAdmin: false })).not.toContain('test-payments');
  });
});
