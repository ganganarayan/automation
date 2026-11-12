/**
 * Rs 1 test payments (owner only, Plan page, Payments).
 *
 * Purpose:      Run the real money path on every plan for one rupee, with the
 *               owner's live Razorpay keys: a real subscription, a real paid
 *               upgrade, a downgrade, a cancel, and the buyer's emails.
 * Responsibility:
 *               - startSubscribe: a Rs 1 monthly subscription on a plan; the
 *                 normal confirm and webhook make the workspace (billingService).
 *               - startUpgrade / confirmUpgrade: a Rs 1 one-time order; once
 *                 paid the workspace moves up and its renewals follow.
 *               - downgrade: move down now, no charge.
 *               - cancel: end the subscription now and lock the workspace.
 *               - list: the test workspaces and where each stands.
 * Dependencies: billingService, billingRepository, tenantRepository,
 *               tenantConfigRepository, usersRepository, providers/razorpayBilling,
 *               inviteService (mail), utils/{billingTestSpec,billingSpec,time}.
 */
import * as billing from './billingService.js';
import * as repo from '../repositories/billingRepository.js';
import * as tenantRepo from '../repositories/tenantRepository.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as users from '../repositories/usersRepository.js';
import * as rzp from '../providers/razorpayBilling.js';
import * as planService from './planService.js';
import * as tenantSettings from '../core/tenantSettings.js';
import { mailFor } from './inviteService.js';
import { settings } from '../settings/index.js';
import { OWNER_TENANT } from '../utils/cancelSpec.js';
import { describe, planKey, cleanBuyer, expiryAfter } from '../utils/billingSpec.js';
import { TEST_SUBS_KEY, TEST_ORDER_PREFIX, rankOf, testQuote, orderSigOk, billingMail } from '../utils/billingTestSpec.js';
import { formatIst } from '../utils/time.js';
import { childLogger } from '../core/logger.js';

const log = childLogger({ module: 'billing-test' });

async function testSubs() {
  try { return JSON.parse((await tenantConfig.get(OWNER_TENANT, TEST_SUBS_KEY)) || '[]') || []; } catch { return []; }
}

/** Is this subscription one of the owner's Rs 1 tests? */
export async function isTestSub(subId) {
  return (await testSubs()).includes(String(subId || ''));
}

/** Send a buyer email from the owner's mail settings. Never throws. */
export async function mail(to, msg) {
  try {
    const m = await mailFor('default');
    if (!m) return { sent: false, error: 'email is not set up in Settings' };
    const out = await m.send({ to, subject: msg.subject, text: msg.text });
    return out && out.ok ? { sent: true } : { sent: false, error: (out && out.error) || 'send failed' };
  } catch (err) {
    log.warn({ err: err.message }, 'billing email failed');
    return { sent: false, error: String(err.message || err).slice(0, 160) };
  }
}

/** Subscribe: a Rs 1 monthly subscription for a new buyer on this plan. */
export async function startSubscribe({ plan, name = '', email = '', phone = '' }) {
  const k = await billing.keys();
  if (!k.keyId || !k.keySecret) throw new Error('Save the Razorpay keys above first');
  const q = testQuote(plan);
  const buyer = cleanBuyer({ name: name || 'Test buyer', business: `Test ${plan}`, email, phone, country: 'IN' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(buyer.email)) throw new Error('Type the test buyer email (a new one, for example you+lite@gmail.com)');
  if (await users.findByEmail(buyer.email)) throw new Error('That email already has an account: use a new one (you+plan@gmail.com works with Gmail)');
  const planId = await billing.razorpayPlanFor(k, q);
  const sub = await rzp.createSubscription(k, {
    plan_id: planId, total_count: 12, customer_notify: 1,
    notes: { plan, bill: 'mo', units: 1, users: 0, email: buyer.email, country: 'IN', test: '1' },
  });
  await repo.createCheckout({ id: sub.id, ...q, ...buyer });
  const list = await testSubs();
  list.push(sub.id);
  await tenantConfig.set(OWNER_TENANT, TEST_SUBS_KEY, JSON.stringify(list.slice(-50)));
  return { keyId: k.keyId, subscriptionId: sub.id, description: `${describe(q)} (test)`, prefill: { name: buyer.name, email: buyer.email, contact: buyer.phone } };
}

async function testWorkspace(tenantId) {
  const t = await tenantRepo.findById(String(tenantId || ''));
  if (!t || !t.billing_sub_id || !(await isTestSub(t.billing_sub_id))) throw new Error('Pick one of your Rs 1 test workspaces');
  const c = await repo.findCheckout(t.billing_sub_id);
  return { t, email: (c && c.email) || t.owner_email || '' };
}

/** Put the workspace on a plan now, reopen it, and point its renewals at that plan's Rs 1 price. */
async function moveTo(t, plan) {
  const q = testQuote(plan);
  await billing.applyPlanKey(t.id, planKey(q));
  const until = expiryAfter(new Date(), 'mo');
  await tenantRepo.setExpiry(t.id, until);
  if (t.cancelled_at) await tenantRepo.setCancelled(t.id, null);
  try {
    const k = await billing.keys();
    await rzp.changePlan(k, t.billing_sub_id, await billing.razorpayPlanFor(k, q));
  } catch (err) {
    // UPI mandates refuse a plan change; the workspace has moved all the same.
    log.info({ tenant: t.id, err: err.message }, 'test renewal plan not changed');
  }
  planService.invalidate();
  tenantSettings.invalidate();
  return until;
}

/** Upgrade: a Rs 1 one-time order; the move happens when it is paid. */
export async function startUpgrade({ tenantId, plan }) {
  const { t, email } = await testWorkspace(tenantId);
  if (!(rankOf(plan) > rankOf(t.plan))) throw new Error('An upgrade goes to a dearer plan');
  const k = await billing.keys();
  const order = await rzp.createOrder(k, { amount: 100, currency: 'INR', receipt: `up-${t.id}`.slice(0, 40), notes: { tenant: t.id, plan, test: '1' } });
  await tenantConfig.set(OWNER_TENANT, `${TEST_ORDER_PREFIX}${order.id}`, JSON.stringify({ tenantId: t.id, plan }));
  return { keyId: k.keyId, orderId: order.id, amount: 100, description: `Upgrade ${t.name || t.id} (test)`, prefill: { email } };
}

export async function confirmUpgrade({ orderId = '', paymentId = '', signature = '' }) {
  const k = await billing.keys();
  if (!orderSigOk({ orderId, paymentId, signature, secret: k.keySecret })) throw new Error('The payment could not be verified');
  let pending = null;
  try { pending = JSON.parse((await tenantConfig.get(OWNER_TENANT, `${TEST_ORDER_PREFIX}${orderId}`)) || 'null'); } catch { pending = null; }
  if (!pending) throw new Error('No such test upgrade');
  const { t, email } = await testWorkspace(pending.tenantId);
  const from = t.plan;
  if (from !== pending.plan) {
    await moveTo(t, pending.plan);
    await repo.logPayment({ paymentId, subId: t.billing_sub_id, tenantId: t.id, currency: 'INR', amount: 100, base: 1, gst: 0, gstin: null }).catch(() => {});
  }
  const sent = await mail(email, billingMail({ kind: 'upgraded', plan: pending.plan, from, workspace: t.name || t.id, base: settings.app.publicBaseUrl, test: true }));
  return { tenant: t.id, plan: pending.plan, email: sent };
}

/** Downgrade: move down now, no charge. */
export async function downgrade({ tenantId, plan }) {
  const { t, email } = await testWorkspace(tenantId);
  if (!(rankOf(plan) >= 0 && rankOf(plan) < rankOf(t.plan))) throw new Error('A downgrade goes to a cheaper plan');
  const from = t.plan;
  await moveTo(t, plan);
  const sent = await mail(email, billingMail({ kind: 'downgraded', plan, from, workspace: t.name || t.id, base: settings.app.publicBaseUrl, test: true }));
  return { tenant: t.id, plan, email: sent };
}

/** Cancel: end the subscription now and lock the workspace. */
export async function cancel({ tenantId }) {
  const { t, email } = await testWorkspace(tenantId);
  let razorpay = 'cancelled';
  try {
    await rzp.cancelNow(await billing.keys(), t.billing_sub_id);
  } catch (err) {
    razorpay = err.message;
  }
  const now = new Date();
  await tenantRepo.setCancelled(t.id, now);
  await tenantRepo.setExpiry(t.id, now);
  planService.invalidate();
  tenantSettings.invalidate();
  const sent = await mail(email, billingMail({ kind: 'cancelled', plan: t.plan, workspace: t.name || t.id, base: settings.app.publicBaseUrl, test: true }));
  return { tenant: t.id, razorpay, email: sent };
}

/** The owner's Rs 1 test workspaces, newest first. */
export async function list() {
  const out = [];
  for (const subId of (await testSubs()).slice().reverse()) {
    const c = await repo.findCheckout(subId).catch(() => null);
    if (!c || !c.tenant_id) continue;
    const t = await tenantRepo.findById(c.tenant_id).catch(() => null);
    if (!t) continue;
    const exp = t.expires_at ? new Date(t.expires_at) : null;
    const ended = !!t.cancelled_at || (exp && exp.getTime() <= Date.now());
    out.push({ tenantId: t.id, name: t.name || t.id, email: c.email, plan: t.plan, ended, until: exp ? formatIst(exp, { withTime: false }) : '' });
  }
  return out;
}

export default { isTestSub, mail, startSubscribe, startUpgrade, confirmUpgrade, downgrade, cancel, list };
