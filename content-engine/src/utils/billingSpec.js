/**
 * Billing rules (pure).
 *
 * Purpose:      What a buyer pays and in which currency, and the checks around a
 *               Razorpay subscription: India pays in rupees with 18% GST added,
 *               everyone else pays in US dollars with no GST.
 * Responsibility: quote, buyer checks, signature checks, webhook reading,
 *               workspace id and expiry dates.
 * Dependencies: node:crypto, utils/planSpec (pure).
 *
 * The currency is decided on the server from where the buyer says the business
 * is billed, never from the page's currency switch. An Indian phone number
 * means India.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PLANS, EXTRAS, MAX_UNITS, MAX_EXTRA_USERS, withGst, validTenantId, monthlyPrice } from './planSpec.js';

export const BUY_PATH = '/buy';
/** Plans on the buy page: one plan per funnel, and Agency per client. */
export const BUYABLE = ['brand', 'agency'];
/** Plans a buyer may be charged for: the buy page's, and Solo (offered when cancelling). */
export const CHARGEABLE = [...BUYABLE, 'solo'];

/** Funnels (or clients) and extra users, as whole numbers within the limits. */
export function cleanCounts(plan, { units = 1, users = 0 } = {}) {
  const per = !!(PLANS[plan] && PLANS[plan].unit);
  const u = Math.floor(Number(units));
  const blank = users === '' || users === undefined || users === null;
  const x = blank ? 0 : Math.floor(Number(users));
  if (per && !(u >= 1 && u <= MAX_UNITS)) throw new Error(`Pick 1 to ${MAX_UNITS} ${PLANS[plan].perUnit === 'client' ? 'clients' : 'funnels'}; for more, write to us`);
  if (!(x >= 0 && x <= MAX_EXTRA_USERS)) throw new Error(`Pick 0 to ${MAX_EXTRA_USERS} extra users`);
  return { units: per ? u : 1, users: x };
}
/** Billing periods: Razorpay period, months paid for, renewals before the subscription ends. */
export const PERIODS = {
  mo: { months: 1, period: 'monthly', count: 120, word: 'monthly', unit: 'month' },
  yr: { months: 12, period: 'yearly', count: 10, word: 'yearly', unit: 'year' },
};
/** Where the owner's Razorpay keys live (tenant_config of the owner's workspace). */
export const BILLING_KEYS = {
  keyId: 'razorpay_key_id',
  keySecret: 'razorpay_key_secret',
  webhookSecret: 'razorpay_billing_webhook_secret',
};
/** Webhook events the owner subscribes to in the Razorpay dashboard. */
export const WEBHOOK_EVENTS = ['subscription.charged', 'subscription.cancelled', 'subscription.halted', 'subscription.completed'];

export const COUNTRIES = { IN: 'India', XX: 'Outside India' };

/** INR for India, USD for everyone else. */
export function currencyFor(country) {
  return String(country || '').toUpperCase() === 'IN' ? 'INR' : 'USD';
}

/** Indian digit grouping (117882 -> "1,17,882"). */
const groupInr = (n) => String(Math.round(Number(n) || 0)).replace(/(\d)(?=(\d\d)+\d$)/g, '$1,');

/** A price for people: "₹1,179", "$12" or "$37.50". */
export function money(n, currency) {
  if (currency === 'INR') return `₹${groupInr(n)}`;
  const cents = Math.round((Number(n) || 0) * 100);
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${whole}${cents % 100 ? `.${String(cents % 100).padStart(2, '0')}` : ''}`;
}

/**
 * What a plan costs this buyer for one period. Amounts are whole rupees or
 * dollars; `amount` is the charge in the smallest unit (paise or cents).
 */
export function quote({ plan, bill = 'mo', country = 'IN', units = 1, users = 0 } = {}) {
  const lim = PLANS[plan];
  if (!lim || !CHARGEABLE.includes(plan)) throw new Error('Pick a plan to buy');
  const p = PERIODS[bill];
  if (!p) throw new Error('Pick monthly or yearly billing');
  const n = cleanCounts(plan, { units, users });
  const currency = currencyFor(country);
  const times = bill === 'yr' ? 10 : 1; // yearly: 12 months for the price of 10
  const month = monthlyPrice(plan, { units: n.units, extraUsers: n.users }, currency);
  const counts = { units: n.units, users: n.users };
  if (currency === 'INR') {
    const base = Math.round(month * times);
    const total = withGst(base);
    return { plan, bill, currency, ...counts, base, gst: total - base, total, amount: total * 100 };
  }
  // Dollars may carry cents ($1.50 an extra user).
  const base = Math.round(month * times * 100) / 100;
  return { plan, bill, currency, ...counts, base, gst: 0, total: base, amount: Math.round(base * 100) };
}

/** Unit prices for the buy page's own sum (the server quotes the charge again). */
export function unitPrices() {
  const out = {};
  for (const plan of CHARGEABLE) {
    const lim = PLANS[plan];
    const u = lim.unit || lim;
    out[plan] = { inr: u.priceInr, usd: u.priceUsd, per: lim.perUnit || '', label: lim.label };
  }
  return { plans: out, user: EXTRAS.user, maxUnits: MAX_UNITS, maxUsers: MAX_EXTRA_USERS };
}

/** Every one-unit price, plan:bill:country (tests and the owner's checks). */
export function quoteTable() {
  const out = {};
  for (const plan of CHARGEABLE) for (const bill of Object.keys(PERIODS)) for (const country of Object.keys(COUNTRIES)) {
    out[`${plan}:${bill}:${country}`] = quote({ plan, bill, country });
  }
  return out;
}

/** What was bought, in words: "3 funnels, 2 extra users". */
export function countsText(q) {
  const lim = PLANS[q.plan];
  const parts = [];
  if (lim && lim.unit) {
    const n = q.units || 1;
    parts.push(`${n} ${lim.perUnit === 'client' ? (n === 1 ? 'client' : 'clients') : (n === 1 ? 'funnel' : 'funnels')}`);
  }
  if (q.users) parts.push(`${q.users} extra user${q.users === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** One line for people: "Always-On Brand (2 funnels), monthly: ₹7,314 (₹6,198 + ₹1,116 GST)". */
export function describe(q) {
  const what = countsText(q);
  const head = `${PLANS[q.plan].label}${what ? ` (${what})` : ''}, ${PERIODS[q.bill].word}: ${money(q.total, q.currency)}`;
  return q.currency === 'INR' ? `${head} (${money(q.base, 'INR')} + ${money(q.gst, 'INR')} GST)` : `${head}, no GST`;
}

/** The cached Razorpay plan for this exact price (a price change makes a new plan). */
export function planKey(q) {
  return `${q.plan}:${q.bill}:${q.currency}:${q.amount}:${q.units || 1}:${q.users || 0}`;
}

/** Plan, funnels or clients, and extra users back from a planKey ('' plan when it is not one). */
export function readPlanKey(key) {
  const [plan, bill, currency, amount, units, users] = String(key || '').split(':');
  if (!PLANS[plan] || !PERIODS[bill]) return { plan: '' };
  return { plan, bill, currency, amount: Number(amount) || 0, units: Number(units) || 1, users: Number(users) || 0 };
}

/** A GSTIN, or blank (it is optional). */
export function validGstin(s) {
  const v = String(s || '').trim().toUpperCase();
  return !v || /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v);
}

/** The buyer's form, tidied. */
export function cleanBuyer(b = {}) {
  return {
    name: String(b.name || '').trim().slice(0, 80),
    business: String(b.business || '').trim().slice(0, 80),
    email: String(b.email || '').trim().toLowerCase().slice(0, 120),
    phone: String(b.phone || '').replace(/[\s()-]/g, '').slice(0, 20),
    country: String(b.country || '').toUpperCase() === 'IN' ? 'IN' : 'XX',
    gstin: String(b.gstin || '').trim().toUpperCase().slice(0, 15),
  };
}

/** Why this buyer's details cannot go ahead ('' = they can). */
export function buyerProblem(b) {
  if (b.name.length < 2) return 'Enter your name';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return 'Enter a valid email: it is your sign-in';
  if (!/^\+?\d{8,15}$/.test(b.phone)) return 'Enter a phone number with its country code';
  if (b.country !== 'IN' && (/^\+91\d{10}$/.test(b.phone) || /^91\d{10}$/.test(b.phone))) {
    return 'An Indian phone number is billed in India, in rupees with GST. Choose India.';
  }
  if (b.gstin && b.country !== 'IN') return 'A GSTIN is for businesses billed in India';
  if (!validGstin(b.gstin)) return 'That GSTIN does not look right (15 characters, like 22AAAAA0000A1Z5)';
  return '';
}

/** HMAC-SHA256 of `payload` with `secret` equals `signature` (hex), in constant time. */
export function sigOk(payload, signature, secret) {
  if (!secret || !signature || payload === undefined || payload === null) return false;
  const want = Buffer.from(createHmac('sha256', String(secret)).update(payload).digest('hex'));
  const got = Buffer.from(String(signature));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Razorpay Checkout's signature for a subscription: HMAC(payment_id|subscription_id, key secret). */
export function checkoutSigOk({ paymentId, subscriptionId, signature, secret }) {
  if (!paymentId || !subscriptionId) return false;
  return sigOk(`${paymentId}|${subscriptionId}`, signature, secret);
}

/**
 * What a Razorpay webhook means for us:
 *   charged: a period was paid (first charge or renewal), paid up to currentEnd
 *   stopped: the subscription ended (cancelled, halted after failed charges, completed)
 *   ignore:  anything else
 */
export function webhookAction(body) {
  const ev = String(body && body.event || '');
  const sub = body && body.payload && body.payload.subscription && body.payload.subscription.entity;
  const pay = body && body.payload && body.payload.payment && body.payload.payment.entity;
  if (!sub || !sub.id) return { kind: 'ignore', event: ev };
  if (ev === 'subscription.charged') {
    return {
      kind: 'charged', event: ev, subId: String(sub.id), currentEnd: Number(sub.current_end) || 0, planId: sub.plan_id ? String(sub.plan_id) : '',
      paymentId: pay && pay.id ? String(pay.id) : '', amount: pay ? Number(pay.amount) || 0 : 0, currency: pay ? String(pay.currency || '') : '',
    };
  }
  if (['subscription.cancelled', 'subscription.halted', 'subscription.completed'].includes(ev)) {
    return { kind: 'stopped', event: ev, subId: String(sub.id) };
  }
  return { kind: 'ignore', event: ev };
}

/** A workspace id from the business or person's name plus a short random suffix. */
export function workspaceIdFrom(name, suffix) {
  let base = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  if (!/^[a-z0-9]/.test(base)) base = 'ws';
  const id = `${base}-${String(suffix || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'x'}`;
  return validTenantId(id) ? id : `ws-${Date.now().toString(36)}`;
}

const DAY = 24 * 60 * 60 * 1000;

/** Paid up to: one period after `from`, plus a day's grace for the renewal charge. */
export function expiryAfter(from, bill) {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + (PERIODS[bill] ? PERIODS[bill].months : 1));
  return new Date(d.getTime() + DAY);
}

/** Paid up to, from a Razorpay subscription's current_end (unix seconds), plus a day's grace. */
export function expiryFromSub(currentEnd) {
  return currentEnd ? new Date(Number(currentEnd) * 1000 + DAY) : null;
}

export default {
  BUY_PATH, BUYABLE, CHARGEABLE, cleanCounts, unitPrices, countsText, readPlanKey, PERIODS, BILLING_KEYS, WEBHOOK_EVENTS, COUNTRIES, currencyFor, money, quote, quoteTable, describe, planKey,
  validGstin, cleanBuyer, buyerProblem, sigOk, checkoutSigOk, webhookAction, workspaceIdFrom, expiryAfter, expiryFromSub,
};
