/**
 * Rs 1 test payments (pure).
 *
 * Purpose:      Let the owner run the real money path on every plan for one
 *               rupee: subscribe, upgrade (paid), downgrade, cancel.
 * Responsibility: test plans in price order, the Rs 1 quote, order signature,
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

/** What a test charge costs: one rupee, no GST, monthly, one funnel or client. */
export function testQuote(plan) {
  if (rankOf(plan) < 0) throw new Error('Pick a plan to test');
  return { plan, bill: 'mo', currency: 'INR', units: 1, users: 0, base: 1, gst: 0, total: 1, amount: 100 };
}

/** Which buttons a row offers for the picked test workspace. */
export function rowActions(rowPlan, picked) {
  const r = rankOf(rowPlan);
  const on = picked && !picked.ended ? rankOf(picked.plan) : -2;
  return {
    upgrade: on >= 0 && r > on,
    downgrade: on >= 0 && r < on,
    cancel: on >= 0 && r === on,
  };
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
  const tag = test ? ' (Rs 1 test)' : '';
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

export default { TEST_PLANS, TEST_SUBS_KEY, TEST_ORDER_PREFIX, rankOf, testQuote, rowActions, orderSigOk, billingMail };
