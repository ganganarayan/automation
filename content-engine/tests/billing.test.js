import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  quote, quoteTable, describe as describeQuote, planKey, currencyFor, money, validGstin, cleanBuyer, buyerProblem,
  checkoutSigOk, sigOk, webhookAction, workspaceIdFrom, expiryAfter, expiryFromSub, BUYABLE,
} from '../src/utils/billingSpec.js';
import { PLANS, validTenantId, withGst } from '../src/utils/planSpec.js';
import { buyPage } from '../src/utils/buyPage.js';
import { homePage, refundPage } from '../src/utils/publicPages.js';
import { planBody } from '../src/utils/planPage.js';

const hmac = (s, k) => createHmac('sha256', k).update(s).digest('hex');
const DASH = String.fromCharCode(0x2014);

describe('prices by where the business is billed', () => {
  it('India pays rupees with 18% GST added, in paise', () => {
    const q = quote({ plan: 'lite', bill: 'mo', country: 'IN' });
    expect(q).toMatchObject({ currency: 'INR', base: 999, gst: 180, total: 1179, amount: 117900 });
    const y = quote({ plan: 'starter', bill: 'yr', country: 'IN' });
    expect(y).toMatchObject({ currency: 'INR', base: 27990, total: withGst(27990), amount: withGst(27990) * 100 });
  });
  it('outside India pays US dollars, no GST, in cents', () => {
    expect(quote({ plan: 'lite', bill: 'mo', country: 'XX' })).toMatchObject({ currency: 'USD', base: 12, gst: 0, total: 12, amount: 1200 });
    expect(quote({ plan: 'agency', bill: 'yr', country: 'US' })).toMatchObject({ currency: 'USD', total: PLANS.agency.priceUsd * 10 });
  });
  it('every buyable plan has a rupee and a dollar price; Custom cannot be bought', () => {
    for (const p of BUYABLE) expect(PLANS[p].priceUsd).toBeGreaterThan(0);
    expect(() => quote({ plan: 'custom' })).toThrow();
    expect(() => quote({ plan: 'lite', bill: 'weekly' })).toThrow();
    expect(Object.keys(quoteTable())).toHaveLength(BUYABLE.length * 4);
  });
  it('a price change makes a new Razorpay plan key, and money reads right', () => {
    expect(planKey(quote({ plan: 'lite', country: 'IN' }))).toBe('lite:mo:INR:117900');
    expect(currencyFor('in')).toBe('INR');
    expect(currencyFor('')).toBe('USD');
    expect(money(117882, 'INR')).toBe('₹1,17,882');
    expect(money(1690, 'USD')).toBe('$1,690');
    expect(describeQuote(quote({ plan: 'lite', country: 'IN' }))).toBe('Starter Lite, monthly: ₹1,179 (₹999 + ₹180 GST)');
  });
});

describe('buyer checks', () => {
  const ok = { name: 'Asha', email: 'A@B.co', phone: '+91 98765 43210', country: 'IN', gstin: '' };
  it('accepts a clean buyer and tidies the fields', () => {
    const b = cleanBuyer(ok);
    expect(b.email).toBe('a@b.co');
    expect(b.phone).toBe('+919876543210');
    expect(buyerProblem(b)).toBe('');
  });
  it('an Indian phone cannot be billed outside India (no dodging GST)', () => {
    expect(buyerProblem(cleanBuyer({ ...ok, country: 'XX' }))).toMatch(/Choose India/);
    expect(buyerProblem(cleanBuyer({ ...ok, country: 'XX', phone: '+1 415 555 0100' }))).toBe('');
  });
  it('checks the GSTIN, only for India', () => {
    expect(validGstin('22AAAAA0000A1Z5')).toBe(true);
    expect(validGstin('nope')).toBe(false);
    expect(buyerProblem(cleanBuyer({ ...ok, gstin: '22aaaaa0000a1z5' }))).toBe('');
    expect(buyerProblem(cleanBuyer({ ...ok, gstin: 'bad' }))).toMatch(/GSTIN/);
    expect(buyerProblem(cleanBuyer({ ...ok, country: 'XX', phone: '+14155550100', gstin: '22AAAAA0000A1Z5' }))).toMatch(/GSTIN/);
    expect(buyerProblem(cleanBuyer({ ...ok, email: 'x' }))).toMatch(/email/);
  });
});

describe('signatures and webhooks', () => {
  it('checks the Checkout signature over payment_id|subscription_id', () => {
    const sig = hmac('pay_1|sub_1', 'sec');
    expect(checkoutSigOk({ paymentId: 'pay_1', subscriptionId: 'sub_1', signature: sig, secret: 'sec' })).toBe(true);
    expect(checkoutSigOk({ paymentId: 'pay_2', subscriptionId: 'sub_1', signature: sig, secret: 'sec' })).toBe(false);
    expect(checkoutSigOk({ paymentId: 'pay_1', subscriptionId: 'sub_1', signature: sig, secret: '' })).toBe(false);
    expect(sigOk(Buffer.from('{"a":1}'), hmac('{"a":1}', 'w'), 'w')).toBe(true);
    expect(sigOk(undefined, 'x', 'w')).toBe(false);
  });
  it('reads charged and stopped events', () => {
    const charged = { event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_1', current_end: 1767225600 } }, payment: { entity: { id: 'pay_1', amount: 117900, currency: 'INR' } } } };
    expect(webhookAction(charged)).toMatchObject({ kind: 'charged', subId: 'sub_1', currentEnd: 1767225600, paymentId: 'pay_1' });
    expect(webhookAction({ event: 'subscription.halted', payload: { subscription: { entity: { id: 'sub_1' } } } }).kind).toBe('stopped');
    expect(webhookAction({ event: 'payment.captured', payload: {} }).kind).toBe('ignore');
  });
  it('makes a valid workspace id and a paid-up date with a day of grace', () => {
    for (const n of ['Asha Foods Pvt. Ltd.', '', '!!!', 'A very long business name that goes on and on']) {
      expect(validTenantId(workspaceIdFrom(n, 'ab12'))).toBe(true);
    }
    expect(expiryAfter(new Date('2026-01-31T00:00:00Z'), 'yr').toISOString()).toBe('2027-02-01T00:00:00.000Z');
    expect(expiryFromSub(1767225600).toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(expiryFromSub(0)).toBe(null);
  });
});

describe('pages', () => {
  it('the buy page carries both currencies, picks India by time zone, and is closed without keys', () => {
    const open = buyPage({ plan: 'lite', ready: true });
    expect(open).toContain('"lite:mo:IN":{"pay":"₹1,179"');
    expect(open).toContain('"lite:mo:XX":{"pay":"$12"');
    expect(open).toContain('checkout.razorpay.com/v1/checkout.js');
    expect(open).toContain('Asia\\/(Kolkata|Calcutta)');
    expect(open).not.toContain('Online payment opens soon');
    const closed = buyPage({ ready: false, email: 'o@x.co' });
    expect(closed).toContain('Online payment opens soon');
    expect(closed).toContain('disabled>Pay');
    expect(buyPage({ cur: 'usd' })).toContain('<option value="XX" selected>');
    for (const h of [open, closed]) expect(h).not.toContain(DASH);
  });
  it('plan cards link to the buy page with the chosen billing and currency', () => {
    const h = homePage();
    for (const id of ['lite', 'starter', 'growth', 'agency']) expect(h).toContain(`data-buy="${id}" href="/buy?plan=${id}"`);
    expect(h).toContain("a.href='/buy?plan='+a.getAttribute('data-buy')+'&bill='+B+'&cur='+C");
    expect(h).toContain('$12<small> / month');
    expect(h.indexOf('class="toggles"')).toBeLessThan(h.indexOf('class="grid plans"'));
    expect(refundPage()).toContain('US dollars, with no GST');
  });
  it('a workspace paid online cannot press Keep my plan once cancelled; the owner sees the Payments box', () => {
    const t = { id: 'asha-1', name: 'Asha', cancelled_at: new Date(), billing_sub_id: 'sub_1', expires_at: new Date() };
    const h = planBody({ tenant: t, role: 'admin' });
    expect(h).not.toContain('Keep my plan</button>');
    expect(h).toContain('buy the plan again');
    const owner = planBody({ tenant: { id: 'default', name: 'Me' }, superAdmin: true, pay: { keyId: '', secretSet: false, webhookSet: false }, origin: 'https://x.y' });
    expect(owner).toContain('Payments (owner only)');
    expect(owner).toContain('https://x.y/buy/webhook');
    expect(planBody({ tenant: t, role: 'admin' })).not.toContain('Payments (owner only)');
  });
});

// The service, with the database and Razorpay replaced.
const db = { checkouts: new Map(), tenants: new Map(), users: new Map(), plans: new Map(), payments: new Map(), cfg: new Map() };
vi.mock('../src/repositories/tenantConfigRepository.js', () => ({ get: async (_t, k) => db.cfg.get(k) ?? null, set: async (_t, k, v) => db.cfg.set(k, v) }));
vi.mock('../src/repositories/billingRepository.js', () => ({
  planId: async (k) => db.plans.get(k) || null,
  savePlanId: async (k, id) => db.plans.set(k, id),
  createCheckout: async (c) => db.checkouts.set(c.id, { ...c, status: 'created', tenant_id: null, paid_at: null }),
  findCheckout: async (id) => db.checkouts.get(id) || null,
  claim: async (id, paymentId) => {
    const c = db.checkouts.get(id);
    if (!c || c.status !== 'created') return null;
    Object.assign(c, { status: 'provisioning', paid_at: c.paid_at || new Date(), payment_id: paymentId || c.payment_id });
    return { ...c };
  },
  release: async (id) => { const c = db.checkouts.get(id); if (c) c.status = 'created'; },
  markProvisioned: async (id, t) => Object.assign(db.checkouts.get(id), { status: 'provisioned', tenant_id: t }),
  setTenantBilling: async (t, sub, cur) => Object.assign(db.tenants.get(t), { billing_sub_id: sub, billing_currency: cur }),
  extendTenant: async (t, at) => { const r = db.tenants.get(t); if (!r.expires_at || r.expires_at < at) r.expires_at = at; },
  logPayment: async (p) => { if (!db.payments.has(p.paymentId)) db.payments.set(p.paymentId, p); },
  resetFirstPassword: async (email) => !!(db.users.get(email) && db.users.get(email).must_change_password),
}));
vi.mock('../src/repositories/tenantRepository.js', () => ({
  findById: async (id) => db.tenants.get(id) || null,
  createNew: async (t) => { const row = { ...t, expires_at: t.expiresAt, cancelled_at: null }; db.tenants.set(t.id, row); return row; },
  setCancelled: async (id, at) => { db.tenants.get(id).cancelled_at = at; return true; },
}));
vi.mock('../src/repositories/usersRepository.js', () => ({
  findByEmail: async (e) => db.users.get(e) || null,
  createForTenant: async (u) => { db.users.set(u.email, { ...u, must_change_password: true }); return u; },
}));
vi.mock('../src/core/tenantSettings.js', () => ({ invalidate: () => {} }));
vi.mock('../src/services/planService.js', () => ({ invalidate: () => {} }));
vi.mock('../src/services/accessService.js', () => ({ invalidateWorkspaces: () => {} }));
const calls = [];
vi.mock('../src/providers/razorpayBilling.js', () => ({
  createPlan: async (_k, p) => { calls.push(['plan', p]); return { id: `plan_${calls.length}` }; },
  createSubscription: async (_k, s) => { calls.push(['sub', s]); return { id: `sub_${calls.length}` }; },
  cancelSubscription: async (_k, id) => { calls.push(['cancel', id]); return {}; },
}));

describe('billing service', () => {
  let svc;
  beforeEach(async () => {
    for (const m of Object.values(db)) m.clear();
    calls.length = 0;
    svc = await import('../src/services/billingService.js');
  });
  const buyer = { plan: 'lite', bill: 'mo', country: 'IN', name: 'Asha', business: 'Asha Foods', email: 'asha@x.co', phone: '+919876543210' };

  it('refuses until the owner saves keys, and checks the key id', async () => {
    await expect(svc.start(buyer)).rejects.toThrow(/not open yet/);
    await expect(svc.saveKeys({ keyId: 'bad' })).rejects.toThrow(/rzp_/);
    const s = await svc.saveKeys({ keyId: 'rzp_test_abc', keySecret: 'ks', webhookSecret: 'ws' });
    expect(s).toMatchObject({ keyId: 'rzp_test_abc', secretSet: true, webhookSet: true, live: false });
    await svc.saveKeys({ keyId: '', keySecret: '' }); // blanks keep what is saved
    expect(await svc.ready()).toBe(true);
  });

  it('India: a rupee plan with GST; then confirm makes the workspace once and shows a one-time password', async () => {
    await svc.saveKeys({ keyId: 'rzp_live_abc', keySecret: 'ks', webhookSecret: 'ws' });
    const s = await svc.start(buyer);
    expect(calls[0][1].item).toMatchObject({ amount: 117900, currency: 'INR' });
    expect(calls[1][1]).toMatchObject({ total_count: 120, notes: { plan: 'lite', country: 'IN' } });
    expect(s.keyId).toBe('rzp_live_abc');
    await expect(svc.confirm({ paymentId: 'pay_1', subscriptionId: s.subscriptionId, signature: 'nope' })).rejects.toThrow(/verified/);
    const sig = hmac(`pay_1|${s.subscriptionId}`, 'ks');
    const r = await svc.confirm({ paymentId: 'pay_1', subscriptionId: s.subscriptionId, signature: sig });
    expect(r.tenant).toMatch(/^asha-foods-/);
    expect(r.tempPassword).toBeTruthy();
    expect(db.tenants.get(r.tenant)).toMatchObject({ plan: 'lite', billing_sub_id: s.subscriptionId, billing_currency: 'INR' });
    expect(db.payments.get('pay_1')).toMatchObject({ currency: 'INR', base: 999, gst: 180 });
    const again = await svc.confirm({ paymentId: 'pay_1', subscriptionId: s.subscriptionId, signature: sig });
    expect(again.tenant).toBe(r.tenant);
    expect(db.tenants.size).toBe(1);
    // the same email cannot buy a second workspace
    await expect(svc.start(buyer)).rejects.toThrow(/already has an account/);
  });

  it('outside India: dollars; the webhook can make the workspace first, renewals extend, a stop cancels', async () => {
    await svc.saveKeys({ keyId: 'rzp_live_abc', keySecret: 'ks', webhookSecret: 'ws' });
    const s = await svc.start({ ...buyer, email: 'bob@x.co', phone: '+14155550100', country: 'XX', bill: 'yr', plan: 'growth' });
    expect(calls[0][1]).toMatchObject({ period: 'yearly', item: { amount: PLANS.growth.priceUsd * 1000, currency: 'USD' } });
    const body = { event: 'subscription.charged', payload: { subscription: { entity: { id: s.subscriptionId, current_end: 1798761600 } }, payment: { entity: { id: 'pay_9' } } } };
    const raw = Buffer.from(JSON.stringify(body));
    expect((await svc.webhook(raw, 'bad', body)).ok).toBe(false);
    const w = await svc.webhook(raw, hmac(raw, 'ws'), body);
    expect(w.tenant).toBeTruthy();
    expect(db.tenants.get(w.tenant).billing_currency).toBe('USD');
    // the browser's confirm after the webhook still gets a one-time password
    const r = await svc.confirm({ paymentId: 'pay_9', subscriptionId: s.subscriptionId, signature: hmac(`pay_9|${s.subscriptionId}`, 'ks') });
    expect(r.tenant).toBe(w.tenant);
    expect(r.tempPassword).toBeTruthy();
    // a renewal moves the expiry on
    const renew = { ...body, payload: { ...body.payload, subscription: { entity: { id: s.subscriptionId, current_end: 1830297600 } }, payment: { entity: { id: 'pay_10' } } } };
    const raw2 = Buffer.from(JSON.stringify(renew));
    await svc.webhook(raw2, hmac(raw2, 'ws'), renew);
    expect(db.tenants.get(w.tenant).expires_at.toISOString()).toBe('2028-01-02T00:00:00.000Z');
    expect(db.payments.size).toBe(2);
    const stop = { event: 'subscription.cancelled', payload: { subscription: { entity: { id: s.subscriptionId } } } };
    const raw3 = Buffer.from(JSON.stringify(stop));
    await svc.webhook(raw3, hmac(raw3, 'ws'), stop);
    expect(db.tenants.get(w.tenant).cancelled_at).toBeTruthy();
    await svc.stopRenewal(db.tenants.get(w.tenant));
    expect(calls.at(-1)).toEqual(['cancel', s.subscriptionId]);
  });
});
