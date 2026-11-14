/**
 * Small test payments (pure).
 *
 * Purpose:      Let the owner run the real money path on every plan for a
 *               little over a rupee: subscribe, upgrade (paid), downgrade, cancel.
 * Responsibility: test plans in price order, the test quote, order signature,
 *               and the emails a buyer gets for each step.
 * Dependencies: node:crypto (via billingSpec), utils/{planSpec,billingSpec,time}.
 */
import { PLANS } from './planSpec.js';
import { sigOk } from './billingSpec.js';

/** Every plan a buyer can be on, cheapest first. Custom is set by hand, so it is left out. */
export const TEST_PLANS = ['lite', 'solo', 'starter', 'brand', 'growth', 'agency'];
/** Where the owner's test subscriptions are listed (tenant_config of the owner's workspace). */
export const TEST_SUBS_KEY = 'billing_test_subs';
export const TEST_ORDER_PREFIX = 'billing_test_order_';
/** Test workspaces the owner cancelled on purpose (not a failed renewal). */
export const TEST_CANCELLED_KEY = 'billing_test_cancelled';

/** A plan's place in the price order, -1 when it is not a test plan. */
export function rankOf(plan) {
  return TEST_PLANS.indexOf(String(plan || ''));
}

/** The currencies a test can charge in, with the smallest and largest amount (major units). */
export const TEST_CURRENCIES = { INR: { min: 1, max: 100 }, USD: { min: 0.5, max: 100 } };

/** A plan's default test price in major units: 1.10 for the cheapest, 1.20 the next and so on. */
export function defaultTestAmount(plan) {
  const r = rankOf(plan);
  return r < 0 ? 0 : (110 + 10 * r) / 100;
}

/** A typed test price in paise or cents, checked against the currency's range. */
export function testAmount(currency = 'INR', price) {
  const c = TEST_CURRENCIES[currency];
  if (!c) throw new Error('Pick INR or USD');
  const n = Number(String(price ?? '').trim());
  if (!Number.isFinite(n) || n < c.min || n > c.max) throw new Error(`Type an amount from ${c.min.toFixed(2)} to ${c.max.toFixed(2)} ${currency}`);
  return Math.round(n * 100);
}

/**
 * What a test charge costs: by default Rs 1.10 for the cheapest plan, Rs 1.20
 * for the next and so on, so each plan's charges are told apart in Razorpay.
 * The owner can pick USD and type another amount. No GST, monthly, one funnel
 * or client. `base` is whole units (the column is whole).
 */
export function testQuote(plan, { currency = 'INR', price } = {}) {
  const r = rankOf(plan);
  if (r < 0) throw new Error('Pick a plan to test');
  const cur = String(currency || 'INR').toUpperCase();
  const amount = testAmount(cur, price === undefined || price === null || price === '' ? defaultTestAmount(plan) : price);
  return { plan, bill: 'mo', currency: cur, units: 1, users: 0, base: 1, gst: 0, total: amount / 100, amount, test: true };
}

/** What a test upgrade to this plan costs, once: that plan's own price (Rs 1.20 for Solo). Paise. */
export function upgradeAmount(plan, opts) {
  return testQuote(plan, opts).amount;
}

/** The plan one step up and one step down from this one ('' at either end). */
export function stepsFrom(plan) {
  const r = rankOf(plan);
  return { up: r >= 0 ? (TEST_PLANS[r + 1] || '') : '', down: r > 0 ? TEST_PLANS[r - 1] : '' };
}

/** "INR 1.10" or "USD 0.50". */
export const money = (currency, minor) => `${currency} ${(minor / 100).toFixed(2)}`;

/** The monthly price of a plan's test subscription: "INR 1.10". */
export function testPrice(plan, opts) {
  const q = testQuote(plan, opts);
  return money(q.currency, q.amount);
}

/** The one-time price of a test upgrade to a plan, the same as its own price: "INR 1.20" for Solo. */
export function upgradePrice(plan, opts) {
  return testPrice(plan, opts);
}

/**
 * What a row's Subscribe cell shows:
 *   paid:   a test workspace on this plan is paid up, so Subscribe is off
 *   lapsed: its renewal failed (not cancelled by you), so pay again for it
 *   new:    no live test workspace on this plan, Subscribe makes one
 * `tests` is the list from billingTestService.list(), newest first.
 */
export function subscribeState(plan, tests = []) {
  const on = (tests || []).filter((t) => t && t.plan === plan);
  const paid = on.find((t) => !t.ended);
  if (paid) return { kind: 'paid', tenantId: paid.tenantId, until: paid.until || '' };
  const lapsed = on.find((t) => t.ended && !t.cancelledByOwner);
  if (lapsed) return { kind: 'lapsed', tenantId: lapsed.tenantId, until: lapsed.until || '' };
  return { kind: 'new' };
}

/**
 * A row is the plan the picked workspace is on now: its Upgrade goes one plan
 * up, its Downgrade one plan down, its Cancel ends it. Only that row is live.
 */
export function rowActions(rowPlan, picked) {
  const live = !!(picked && !picked.ended && picked.plan === rowPlan && rankOf(rowPlan) >= 0);
  const s = stepsFrom(rowPlan);
  return { upgrade: live && !!s.up, downgrade: live && !!s.down, cancel: live };
}

/** Razorpay's signature on a paid order: HMAC of "order_id|payment_id". */
export function orderSigOk({ orderId, paymentId, signature, secret }) {
  if (!orderId || !paymentId) return false;
  return sigOk(`${orderId}|${paymentId}`, signature, secret);
}

const label = (plan) => (PLANS[plan] && PLANS[plan].label) || plan;

/**
 * The email a buyer gets. kind: welcome | upgraded | downgraded | renewed | cancelled.
 * `base` is the app's sign-in address; `until` is already DD-MM-YYYY.
 */
export function billingMail({ kind, plan = '', from = '', workspace = '', email = '', tempPassword = '', base = '', until = '', test = false }) {
  const signIn = `${String(base || '').replace(/\/+$/, '')}/api/v1/admin/login`;
  const tag = test ? ' (test payment)' : '';
  if (kind === 'welcome') {
    return {
      subject: `Your Content Engine workspace is ready${tag}`,
      text: [
        `Thank you for buying ${label(plan)}${tag}.`,
        '',
        `Workspace: ${workspace}`,
        `Sign in: ${signIn}`,
        `Email: ${email}`,
        tempPassword ? `One-time password: ${tempPassword} (you will set your own when you sign in)` : '',
        until ? `Paid until: ${until}` : '',
      ].filter(Boolean).join('\n'),
    };
  }
  if (kind === 'upgraded' || kind === 'downgraded') {
    const up = kind === 'upgraded';
    return {
      subject: `Your plan is now ${label(plan)}${tag}`,
      text: [
        `Your workspace ${workspace} moved from ${label(from)} to ${label(plan)}${tag}.`,
        up ? 'The features of the new plan are open now.' : 'Features outside the new plan are switched off now.',
        `Sign in: ${signIn}`,
      ].join('\n'),
    };
  }
  if (kind === 'renewed') {
    return {
      subject: `Your Content Engine plan is paid again${tag}`,
      text: [
        `Thank you. ${workspace} (${label(plan)}) is paid again${tag} and open now.`,
        until ? `Paid until: ${until}` : '',
        'Renewals now use the payment method you just paid with.',
        `Sign in: ${signIn}`,
      ].filter(Boolean).join('\n'),
    };
  }
  if (kind === 'cancelled') {
    return {
      subject: `Your Content Engine subscription is cancelled${tag}`,
      text: [
        `The subscription for ${workspace} (${label(plan)}) is cancelled${tag}.`,
        test ? 'This was a test, so the workspace is locked now: you can look but not post.' : (until ? `You keep full use until ${until}; it does not renew.` : 'It does not renew.'),
        `Sign in: ${signIn}`,
      ].join('\n'),
    };
  }
  throw new Error(`unknown billing email: ${kind}`);
}

export default { TEST_CURRENCIES, defaultTestAmount, testAmount, money, TEST_CANCELLED_KEY, subscribeState, TEST_PLANS, TEST_SUBS_KEY, TEST_ORDER_PREFIX, rankOf, testQuote, testPrice, upgradeAmount, upgradePrice, stepsFrom, rowActions, orderSigOk, billingMail };
