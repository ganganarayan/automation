/**
 * Self-serve billing: buy a plan, get a workspace.
 *
 * Purpose:      The buy page starts a Razorpay subscription in rupees (India,
 *               18% GST added) or US dollars (outside India, no GST). When the
 *               first charge goes through, the workspace and its admin login are
 *               made; each renewal moves the workspace's expiry on; a cancel on
 *               the Plan page stops the renewal at the end of the period.
 * Responsibility: Orchestration; rules live in utils/billingSpec (pure).
 * Dependencies: billingRepository, tenantRepository, usersRepository,
 *               tenantConfigRepository, providers/razorpayBilling.
 *
 * Keys are the owner's (Plan page, Payments), in tenant_config of the owner's
 * workspace, never env. The Checkout handler (confirm) and the webhook both
 * report the first charge; whichever arrives first makes the workspace, once.
 */
import { randomBytes } from 'node:crypto';
import * as repo from '../repositories/billingRepository.js';
import * as tenantRepo from '../repositories/tenantRepository.js';
import * as users from '../repositories/usersRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as rzp from '../providers/razorpayBilling.js';
import * as tenantSettings from '../core/tenantSettings.js';
import * as planService from './planService.js';
import { invalidateWorkspaces } from './accessService.js';
import { hashPassword } from '../utils/passwordSpec.js';
import { PLANS } from '../utils/planSpec.js';
import { OWNER_TENANT } from '../utils/cancelSpec.js';
import {
  BILLING_KEYS, PERIODS, quote, describe, planKey, readPlanKey, countsText, cleanBuyer, buyerProblem, sigOk, checkoutSigOk,
  webhookAction, workspaceIdFrom, expiryAfter, expiryFromSub, money,
} from '../utils/billingSpec.js';

const HOUR = 60 * 60 * 1000;

/** The owner's Razorpay keys ('' when not set). */
export async function keys() {
  const [keyId, keySecret, webhookSecret] = await Promise.all(
    [BILLING_KEYS.keyId, BILLING_KEYS.keySecret, BILLING_KEYS.webhookSecret].map((k) => tenantConfig.get(OWNER_TENANT, k).catch(() => null)),
  );
  return { keyId: keyId || '', keySecret: keySecret || '', webhookSecret: webhookSecret || '' };
}

/** Can people pay yet? */
export async function ready() {
  const k = await keys();
  return !!(k.keyId && k.keySecret);
}

/** Save the owner's keys; a blank field keeps what is saved. */
export async function saveKeys({ keyId = '', keySecret = '', webhookSecret = '' } = {}) {
  const id = String(keyId).trim();
  if (id && !/^rzp_(live|test)_[A-Za-z0-9]+$/.test(id)) throw new Error('The Key Id starts with rzp_live_ or rzp_test_');
  if (id) await tenantConfig.set(OWNER_TENANT, BILLING_KEYS.keyId, id);
  if (String(keySecret).trim()) await tenantConfig.set(OWNER_TENANT, BILLING_KEYS.keySecret, String(keySecret).trim());
  if (String(webhookSecret).trim()) await tenantConfig.set(OWNER_TENANT, BILLING_KEYS.webhookSecret, String(webhookSecret).trim());
  const k = await keys();
  return { keyId: k.keyId, secretSet: !!k.keySecret, webhookSet: !!k.webhookSecret, live: k.keyId.startsWith('rzp_live_') };
}

/** The Razorpay plan for this exact price, made once and cached. */
async function razorpayPlan(k, q) {
  const key = planKey(q);
  const cached = await repo.planId(key);
  if (cached) return cached;
  const plan = await rzp.createPlan(k, {
    period: PERIODS[q.bill].period,
    item: {
      name: `Content Engine ${PLANS[q.plan].label}${countsText(q) ? `, ${countsText(q)}` : ''} (${PERIODS[q.bill].word})`.slice(0, 120),
      amount: q.amount,
      currency: q.currency,
      description: q.currency === 'INR' ? `${money(q.base, 'INR')} + 18% GST ${money(q.gst, 'INR')}` : 'Billed outside India, no GST',
    },
  });
  await repo.savePlanId(key, plan.id);
  return plan.id;
}

/**
 * Start a purchase: check the buyer, price it in their currency, open a
 * Razorpay subscription. Returns what the page needs to open Checkout.
 */
export async function start(input = {}) {
  const k = await keys();
  if (!k.keyId || !k.keySecret) throw new Error('Online payment is not open yet. Write to us and we will set up your workspace.');
  const buyer = cleanBuyer(input);
  const why = buyerProblem(buyer);
  if (why) throw new Error(why);
  if (await users.findByEmail(buyer.email)) throw new Error('That email already has an account. Sign in, or use another email.');
  const plan = String(input.plan || '');
  // Solo is offered only when cancelling (Plan page), never to a new buyer.
  if (plan === 'solo') throw new Error('Pick a plan to buy');
  const q = quote({ plan, bill: String(input.bill || 'mo'), country: buyer.country, units: input.units ?? 1, users: input.users ?? 0 });
  const planId = await razorpayPlan(k, q);
  const sub = await rzp.createSubscription(k, {
    plan_id: planId,
    total_count: PERIODS[q.bill].count,
    customer_notify: 1,
    notes: { plan: q.plan, bill: q.bill, units: q.units, users: q.users, email: buyer.email, country: buyer.country, gstin: buyer.gstin || '', business: buyer.business.slice(0, 60) },
  });
  await repo.createCheckout({ id: sub.id, ...q, ...buyer });
  return {
    keyId: k.keyId,
    subscriptionId: sub.id,
    description: describe(q),
    prefill: { name: buyer.name, email: buyer.email, contact: buyer.phone },
  };
}

/** Workspace, admin login and billing link for a paid checkout, once. */
async function provision(subId, { paymentId = '', expiresAt = null } = {}) {
  const c = await repo.claim(subId, paymentId);
  if (!c) {
    const done = await repo.findCheckout(subId);
    if (!done) throw new Error('No such purchase');
    return { checkout: done, tenant: done.tenant_id || '', tempPassword: '', made: false };
  }
  try {
    let id = '';
    for (let i = 0; i < 6; i += 1) {
      id = workspaceIdFrom(c.business || c.name || c.email.split('@')[0], randomBytes(3).toString('hex'));
      if (!(await tenantRepo.findById(id))) break;
    }
    const expires = expiresAt || expiryAfter(new Date(), c.bill);
    const units = PLANS[c.plan] && PLANS[c.plan].unit ? Number(c.units) || 1 : null;
    const t = await tenantRepo.createNew({ id, name: c.business || c.name || id, ownerEmail: c.email, phone: c.phone || '', plan: c.plan, expiresAt: expires, units, extraUsers: Number(c.extra_users) || 0 });
    const tempPassword = randomBytes(9).toString('base64url');
    await users.createForTenant({ email: c.email, tenantId: t.id, role: 'admin', passwordHash: await hashPassword(tempPassword) });
    await repo.setTenantBilling(t.id, subId, c.currency);
    await repo.markProvisioned(subId, t.id);
    tenantSettings.invalidate();
    planService.invalidate();
    invalidateWorkspaces();
    return { checkout: { ...c, tenant_id: t.id }, tenant: t.id, tempPassword, made: true };
  } catch (err) {
    await repo.release(subId);
    throw err;
  }
}

const paymentRow = (c, paymentId, tenantId) => ({
  paymentId, subId: c.id, tenantId, currency: c.currency, amount: c.amount, base: c.base, gst: c.gst, gstin: c.gstin,
});

/**
 * The Checkout handler's report: check Razorpay's signature, make the
 * workspace and hand back its sign-in. If the webhook made it first, a fresh
 * one-time password is issued, as long as nobody has signed in yet and the
 * payment is under an hour old (only the payer's browser holds the signature).
 */
export async function confirm({ paymentId = '', subscriptionId = '', signature = '' } = {}) {
  const k = await keys();
  if (!checkoutSigOk({ paymentId, subscriptionId, signature, secret: k.keySecret })) {
    throw new Error('The payment could not be verified. If money left your account, write to us with the payment id.');
  }
  const r = await provision(subscriptionId, { paymentId });
  const c = r.checkout;
  if (c.tenant_id) await repo.logPayment(paymentRow(c, paymentId, c.tenant_id));
  let tempPassword = r.tempPassword;
  if (!tempPassword && c.tenant_id && c.paid_at && Date.now() - new Date(c.paid_at).getTime() < HOUR) {
    const fresh = randomBytes(9).toString('base64url');
    if (await repo.resetFirstPassword(c.email, await hashPassword(fresh))) tempPassword = fresh;
  }
  return { tenant: c.tenant_id || '', email: c.email, tempPassword, expires: '' };
}

/**
 * Razorpay's webhook. Checked against the owner's webhook secret over the raw
 * body. A charge makes the workspace if confirm has not, then moves its expiry
 * to the end of the paid period; an ended subscription marks it cancelled.
 */
export async function webhook(rawBody, signature, body) {
  const k = await keys();
  if (!k.webhookSecret || !sigOk(rawBody, signature, k.webhookSecret)) return { ok: false, status: 400, error: 'bad signature' };
  const a = webhookAction(body);
  if (a.kind === 'ignore') return { ok: true, ignored: a.event };
  const c = await repo.findCheckout(a.subId);
  if (!c) return { ok: true, ignored: 'not from the buy page' };
  if (a.kind === 'charged') {
    const until = expiryFromSub(a.currentEnd);
    let tenantId = c.tenant_id;
    if (!tenantId) tenantId = (await provision(a.subId, { paymentId: a.paymentId, expiresAt: until })).tenant;
    if (tenantId && until) await repo.extendTenant(tenantId, until);
    // A plan change (Solo, chosen when cancelling) takes effect with the charge on the new plan.
    if (tenantId && a.planId) await followPlan(tenantId, a.planId);
    if (tenantId && a.paymentId) await repo.logPayment(paymentRow(c, a.paymentId, tenantId));
    planService.invalidate();
    return { ok: true, tenant: tenantId, until };
  }
  if (c.tenant_id) {
    const t = await tenantRepo.findById(c.tenant_id);
    if (t && !t.cancelled_at) await tenantRepo.setCancelled(c.tenant_id, new Date());
  }
  return { ok: true, stopped: a.event };
}

/** Put the workspace on the plan its subscription now charges for, if that changed. */
async function followPlan(tenantId, razorpayPlanId) {
  await applyPlanKey(tenantId, await repo.keyForPlanId(razorpayPlanId).catch(() => ''));
}

/**
 * Put a workspace on the plan, funnels or clients and extra users a planKey
 * names. Returns true when it changed something. (The QA check calls it too.)
 */
export async function applyPlanKey(tenantId, key) {
  const k = readPlanKey(key);
  if (!k.plan) return false;
  const t = await tenantRepo.findById(tenantId);
  if (!t) return false;
  const units = PLANS[k.plan].unit ? k.units : null;
  if (t.plan === k.plan && (t.units ?? null) === units && (Number(t.extra_users) || 0) === k.users) return false;
  await tenantRepo.setPlanUnits(tenantId, k.plan, units, k.users);
  if (t.cancelled_at) await tenantRepo.setCancelled(tenantId, null);
  planService.invalidate();
  tenantSettings.invalidate();
  return true;
}

/**
 * The cancel page's offer: keep posting on Solo (1 funnel, 5 channels, the
 * lean build) instead of leaving. The subscription moves to Solo from its next
 * renewal; the workspace follows when that charge arrives (webhook).
 */
export async function switchToSolo(tenant) {
  if (!tenant || !tenant.billing_sub_id) throw new Error('Your plan was set up by us: write to us and we will move you to Solo.');
  const k = await keys();
  const q = quote({ plan: 'solo', bill: 'mo', country: tenant.billing_currency === 'INR' ? 'IN' : 'XX' });
  const planId = await razorpayPlan(k, q);
  try {
    await rzp.changePlan(k, tenant.billing_sub_id, planId);
  } catch (err) {
    throw new Error(`Your payment method does not allow a plan change (${err.message}). Write to us and we will move you to Solo.`);
  }
  return { plan: 'solo', price: describe(q) };
}

/** The Plan page's cancel: stop the Razorpay renewal at the end of the period. */
export async function stopRenewal(tenant) {
  if (!tenant || !tenant.billing_sub_id) return { stopped: false };
  await rzp.cancelSubscription(await keys(), tenant.billing_sub_id);
  return { stopped: true };
}

export default { keys, ready, saveKeys, start, confirm, webhook, stopRenewal, switchToSolo, applyPlanKey };
