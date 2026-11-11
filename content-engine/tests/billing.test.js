import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  quote, quoteTable, describe as describeQuote, planKey, currencyFor, money, validGstin, cleanBuyer, buyerProblem,
  checkoutSigOk, sigOk, webhookAction, workspaceIdFrom, expiryAfter, expiryFromSub, BUYABLE, CHARGEABLE, readPlanKey, cleanCounts,
} from '../src/utils/billingSpec.js';
import { PLANS, validTenantId, withGst, limitsForTenant, monthlyPrice, overLimit } from '../src/utils/planSpec.js';
import { buyPage } from '../src/utils/buyPage.js';
import { homePage, refundPage } from '../src/utils/publicPages.js';
import { planBody, soloOffer } from '../src/utils/planPage.js';

const hmac = (s, k) => createHmac('sha256', k).update(s).digest('hex');
const DASH = String.fromCharCode(0x2014);

describe('prices by where the business is billed', () => {
  it('India pays rupees with 18% GST added, in paise, per funnel', () => {
    const q = quote({ plan: 'brand', bill: 'mo', country: 'IN' });
    expect(q).toMatchObject({ currency: 'INR', units: 1, users: 0, base: 3199, gst: 576, total: 3775, amount: 377500 });
    const y = quote({ plan: 'brand', bill: 'yr', country: 'IN', units: 3, users: 2 });
    const base = (3199 * 3 + 100 * 2) * 10;
    expect(y).toMatchObject({ currency: 'INR', units: 3, users: 2, base, total: withGst(base), amount: withGst(base) * 100 });
  });
  it('outside India pays US dollars, no GST, in cents (an extra user is $1.50)', () => {
    expect(quote({ plan: 'brand', bill: 'mo', country: 'XX' })).toMatchObject({ currency: 'USD', base: 37, gst: 0, total: 37, amount: 3700 });
    expect(quote({ plan: 'agency', bill: 'mo', country: 'XX', units: 4, users: 1 })).toMatchObject({ total: 189.5, amount: 18950 });
    expect(quote({ plan: 'agency', bill: 'yr', country: 'US', units: 2 })).toMatchObject({ currency: 'USD', total: 47 * 2 * 10 });
  });
  it('only the per-funnel plan and Agency are on sale; Solo is chargeable but not buyable; counts are checked', () => {
    expect(BUYABLE).toEqual(['brand', 'agency']);
    expect(CHARGEABLE).toContain('solo');
    expect(() => quote({ plan: 'custom' })).toThrow();
    expect(() => quote({ plan: 'lite' })).toThrow();
    expect(() => quote({ plan: 'brand', bill: 'weekly' })).toThrow();
    expect(() => quote({ plan: 'brand', units: 0 })).toThrow(/funnels/);
    expect(() => quote({ plan: 'agency', units: 51 })).toThrow(/clients/);
    expect(() => quote({ plan: 'brand', users: -1 })).toThrow(/users/);
    expect(cleanCounts('solo', { units: 9 })).toEqual({ units: 1, users: 0 });
    expect(Object.keys(quoteTable())).toHaveLength(CHARGEABLE.length * 4);
  });
  it('a price change makes a new Razorpay plan key that reads back, and money reads right', () => {
    const q = quote({ plan: 'agency', country: 'IN', units: 3, users: 1 });
    expect(planKey(q)).toBe('agency:mo:INR:1427400:3:1');
    expect(readPlanKey(planKey(q))).toMatchObject({ plan: 'agency', units: 3, users: 1 });
    expect(readPlanKey('junk').plan).toBe('');
    expect(currencyFor('in')).toBe('INR');
    expect(currencyFor('')).toBe('USD');
    expect(money(117882, 'INR')).toBe('₹1,17,882');
    expect(money(1690, 'USD')).toBe('$1,690');
    expect(money(181.5, 'USD')).toBe('$181.50');
    expect(describeQuote(quote({ plan: 'brand', country: 'IN', units: 2 }))).toBe('Always-On Brand (2 funnels), monthly: ₹7,550 (₹6,398 + ₹1,152 GST)');
  });
  it('limits scale with what was bought; a workspace without units keeps its flat plan', () => {
    expect(limitsForTenant('brand', { units: 3, extraUsers: 2 })).toMatchObject({ funnels: 3, channels: 10, posts: 90, users: 3 });
    expect(limitsForTenant('agency', { units: 4 })).toMatchObject({ clients: 4, posts: 120, users: 5, channels: 10 });
    expect(limitsForTenant('agency')).toMatchObject({ clients: 10, posts: 300 });
    expect(limitsForTenant('starter', { extraUsers: 1 }).users).toBe(2);
    expect(monthlyPrice('brand', { units: 2, extraUsers: 1 }, 'USD')).toBe(75.5);
    expect(overLimit('brand', 'funnels', 1, 1)).toMatch(/Add a funnel/);
    expect(overLimit('brand', 'funnels', 2, 1, limitsForTenant('brand', { units: 3 }))).toBe('');
  });
  it('every plan on sale keeps at least 50% after the Razorpay fee and provider cost, yearly too', () => {
    const cost = { brand: 1188, agency: 1188, solo: 660 }; // rupees a month per unit
    for (const plan of CHARGEABLE) {
      const yearlyMonth = (PLANS[plan].unit || PLANS[plan]).priceInr * 10 / 12;
      const margin = (yearlyMonth * 0.972152 - cost[plan]) / yearlyMonth;
      expect(margin).toBeGreaterThanOrEqual(0.5);
    }
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
    expect(buyerProblem(cleanBuyer({ ...ok, country: 'XX' }))).toMatch(/another currency/);
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
  it('the buy page carries one currency from the IP, no picker, no Solo, and is closed without keys', () => {
    const open = buyPage({ plan: 'agency', units: '3', ready: true, cur: 'inr' });
    expect(open).toContain('"brand":{"p":3199,"per":"funnel"}');
    expect(open).toContain('"agency":{"p":3999,"per":"client"}');
    expect(open).toContain('<input type="hidden" name="country" id="country" value="IN">');
    expect(open).toContain('GSTIN');
    expect(open).not.toContain('"solo"');
    expect(open).toContain('name="units" id="units" type="number" min="1" max="50" value="3"');
    expect(open).toContain('<option value="agency" selected>');
    expect(open).not.toContain('<option value="solo"');
    expect(open).toContain('checkout.razorpay.com/v1/checkout.js');
    expect(open).not.toContain('Kolkata');
    expect(open).not.toContain('Online payment opens soon');
    const closed = buyPage({ ready: false, email: 'o@x.co' });
    expect(closed).toContain('Online payment opens soon');
    expect(closed).toContain('disabled>Pay');
    const usd = buyPage({ cur: 'usd', ready: true });
    expect(usd).toContain('value="XX"');
    expect(usd).toContain('"brand":{"p":37,"per":"funnel"}');
    for (const hint of ['₹', 'GST', 'India', '\\u20b9', '+91']) expect(usd).not.toContain(hint);
    for (const h of [open, closed]) expect(h).not.toContain(DASH);
  });
  it('plan cards link to the buy page with the chosen billing; no currency switch', () => {
    const h = homePage({ cur: 'usd' });
    for (const id of ['brand', 'agency']) expect(h).toContain(`data-buy="${id}" href="/buy?plan=${id}"`);
    expect(h).toContain("a.href='/buy?plan='+a.getAttribute('data-buy')+'&bill='+B;");
    expect(h).not.toContain('aria-label="Currency"');
    expect(h).toContain('$37<small> / month');
    for (const hint of ['₹', 'GST', 'India', 'rupee', 'IST']) expect(h).not.toContain(hint);
    expect(h.indexOf('class="toggles"')).toBeLessThan(h.indexOf('class="grid plans'));
    expect(refundPage({ cur: 'usd' })).toContain('paid in US dollars');
    expect(refundPage({ cur: 'usd' })).not.toContain('GST');
    expect(refundPage({ cur: 'inr' })).toContain('18% GST');
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
  it('Solo is offered only to someone about to cancel, never to a client or a Solo workspace', () => {
    const paid = { id: 'a', name: 'A', plan: 'brand', units: 2, billing_sub_id: 'sub_1', billing_currency: 'INR', expires_at: new Date() };
    const h = planBody({ tenant: paid, role: 'admin' });
    expect(h).toContain('Always-On Brand, 2 funnels');
    expect(h).toContain('Before you go: Solo');
    expect(h).toContain('₹1,699 + GST a month');
    expect(h).toContain('/solo"');
    expect(h.indexOf('Before you go')).toBeLessThan(h.indexOf('Cancel my plan'));
    expect(soloOffer({ ...paid, billing_currency: 'USD' })).toContain('$20 a month');
    expect(soloOffer({ ...paid, billing_sub_id: null })).not.toContain('<form');
    expect(soloOffer({ ...paid, plan: 'solo' })).toBe('');
    expect(soloOffer({ ...paid, parent_id: 'ag' })).toBe('');
    expect(planBody({ tenant: { ...paid, cancelled_at: new Date() }, role: 'admin' })).not.toContain('Before you go');
  });
});

// The service, with the database and Razorpay replaced.
const db = { checkouts: new Map(), tenants: new Map(), users: new Map(), plans: new Map(), payments: new Map(), cfg: new Map() };
vi.mock('../src/repositories/tenantConfigRepository.js', () => ({ get: async (_t, k) => db.cfg.get(k) ?? null, set: async (_t, k, v) => db.cfg.set(k, v) }));
vi.mock('../src/repositories/billingRepository.js', () => ({
  planId: async (k) => db.plans.get(k) || null,
  savePlanId: async (k, id) => db.plans.set(k, id),
  keyForPlanId: async (id) => [...db.plans.entries()].find(([, v]) => v === id)?.[0] || '',
  createCheckout: async (c) => db.checkouts.set(c.id, { ...c, extra_users: c.users, status: 'created', tenant_id: null, paid_at: null }),
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
  setPlanUnits: async (id, plan, units, extraUsers) => Object.assign(db.tenants.get(id), { plan, units, extra_users: extraUsers }),
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
  changePlan: async (_k, id, planId) => { calls.push(['change', id, planId]); return {}; },
}));

describe('billing service', () => {
  let svc;
  beforeEach(async () => {
    for (const m of Object.values(db)) m.clear();
    calls.length = 0;
    svc = await import('../src/services/billingService.js');
  });
  const buyer = { plan: 'brand', units: 2, users: 1, bill: 'mo', country: 'IN', name: 'Asha', business: 'Asha Foods', email: 'asha@x.co', phone: '+919876543210' };

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
    expect(calls[0][1].item).toMatchObject({ amount: withGst(3199 * 2 + 100) * 100, currency: 'INR' });
    expect(calls[0][1].item.name).toBe('Content Engine Always-On Brand, 2 funnels, 1 extra user (monthly)');
    expect(calls[1][1]).toMatchObject({ total_count: 120, notes: { plan: 'brand', units: 2, users: 1, country: 'IN' } });
    await expect(svc.start({ ...buyer, email: 'solo@x.co', plan: 'solo' })).rejects.toThrow(/Pick a plan/);
    expect(s.keyId).toBe('rzp_live_abc');
    await expect(svc.confirm({ paymentId: 'pay_1', subscriptionId: s.subscriptionId, signature: 'nope' })).rejects.toThrow(/verified/);
    const sig = hmac(`pay_1|${s.subscriptionId}`, 'ks');
    const r = await svc.confirm({ paymentId: 'pay_1', subscriptionId: s.subscriptionId, signature: sig });
    expect(r.tenant).toMatch(/^asha-foods-/);
    expect(r.tempPassword).toBeTruthy();
    expect(db.tenants.get(r.tenant)).toMatchObject({ plan: 'brand', units: 2, extraUsers: 1, billing_sub_id: s.subscriptionId, billing_currency: 'INR' });
    expect(db.payments.get('pay_1')).toMatchObject({ currency: 'INR', base: 6498, gst: withGst(6498) - 6498 });
    const again = await svc.confirm({ paymentId: 'pay_1', subscriptionId: s.subscriptionId, signature: sig });
    expect(again.tenant).toBe(r.tenant);
    expect(db.tenants.size).toBe(1);
    // the same email cannot buy a second workspace
    await expect(svc.start(buyer)).rejects.toThrow(/already has an account/);
  });

  it('outside India: dollars; the webhook can make the workspace first, renewals extend, a stop cancels', async () => {
    await svc.saveKeys({ keyId: 'rzp_live_abc', keySecret: 'ks', webhookSecret: 'ws' });
    const s = await svc.start({ ...buyer, email: 'bob@x.co', phone: '+14155550100', country: 'XX', bill: 'yr', plan: 'agency', units: 3, users: 0 });
    expect(calls[0][1]).toMatchObject({ period: 'yearly', item: { amount: 47 * 3 * 1000, currency: 'USD' } });
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
    expect(db.tenants.get(w.tenant)).toMatchObject({ plan: 'agency', units: 3 });
  });

  it('Solo: the subscription moves at the next renewal, and the workspace follows the charge', async () => {
    await svc.saveKeys({ keyId: 'rzp_live_abc', keySecret: 'ks', webhookSecret: 'ws' });
    const s = await svc.start(buyer);
    const sig = hmac(`pay_1|${s.subscriptionId}`, 'ks');
    const r = await svc.confirm({ paymentId: 'pay_1', subscriptionId: s.subscriptionId, signature: sig });
    const t = db.tenants.get(r.tenant);
    const out = await svc.switchToSolo(t);
    expect(out.plan).toBe('solo');
    const change = calls.find((c) => c[0] === 'change');
    expect(change[1]).toBe(s.subscriptionId);
    const soloPlanId = change[2];
    expect(calls.find((c) => c[0] === 'plan' && c[1].item.amount === withGst(1699) * 100)).toBeTruthy();
    // the next charge is on the Solo plan: the workspace moves to Solo
    const body = { event: 'subscription.charged', payload: { subscription: { entity: { id: s.subscriptionId, current_end: 1798761600, plan_id: soloPlanId } }, payment: { entity: { id: 'pay_2' } } } };
    const raw = Buffer.from(JSON.stringify(body));
    await svc.webhook(raw, hmac(raw, 'ws'), body);
    expect(db.tenants.get(r.tenant)).toMatchObject({ plan: 'solo', units: null, extra_users: 0 });
    await expect(svc.switchToSolo({ id: 'x' })).rejects.toThrow(/write to us/);
  });
});
