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

/** A plan's place in the price order, -1 when it is not a test plan. */
export function rankOf(plan) {
  return TEST_PLANS.indexOf(String(plan || ''));
}

/**
 * What a test charge costs: Rs 1.10 for the cheapest plan, Rs 1.20 for the
 * next and so on, so each plan's charges are told apart in Razorpay. No GST,
 * monthly, one funnel or client. `base` is whole rupees (the column is whole).
 */
export function testQuote(plan) {
  const r = rankOf(plan);
  if (r < 0) throw new Error('Pick a plan to test');
  const amount = 100 + 10 * (r + 1);
  return { plan, bill: 'mo', currency: 'INR', units: 1, users: 0, base: 1, gst: 0, total: amount / 100, amount, test: true };
}

/** What a test upgrade to this plan costs, once: that plan's own price (Rs 1.20 for Solo). Paise. */
export function upgradeAmount(plan) {
  return testQuote(plan).amount;
}

/** The plan one step up and one step down from this one ('' at either end). */
export function stepsFrom(plan) {
  const r = rankOf(plan);
  return { up: r >= 0 ? (TEST_PLANS[r + 1] || '') : '', down: r > 0 ? TEST_PLANS[r - 1] : '' };
}

const rupees = (paise) => `₹${(paise / 100).toFixed(2)}`;

/** The monthly price of a plan's test subscription: "₹1.10". */
export function testPrice(plan) {
  return rupees(testQuote(plan).amount);
}

/** The one-time price of a test upgrade to a plan, the same as its own price: "₹1.20" for Solo. */
export function upgradePrice(plan) {
  return rupees(upgradeAmount(plan));
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
 * The email a buyer gets. kind: welcome | upgraded | downgraded | cancelled.
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

export default { TEST_PLANS, TEST_SUBS_KEY, TEST_ORDER_PREFIX, rankOf, testQuote, testPrice, upgradeAmount, upgradePrice, stepsFrom, rowActions, orderSigOk, billingMail };
