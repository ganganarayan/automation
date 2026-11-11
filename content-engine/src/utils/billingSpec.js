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
import { PLANS, withGst, validTenantId } from './planSpec.js';

export const BUY_PATH = '/buy';
/** Plans a person can buy on their own (Custom is set up by the owner). */
export const BUYABLE = ['lite', 'starter', 'growth', 'agency'];
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

/** A price for people: "₹1,179" or "$12". */
export function money(n, currency) {
  return currency === 'INR' ? `₹${groupInr(n)}` : `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

/**
 * What a plan costs this buyer for one period. Amounts are whole rupees or
 * dollars; `amount` is the charge in the smallest unit (paise or cents).
 */
export function quote({ plan, bill = 'mo', country = 'IN' } = {}) {
  const lim = PLANS[plan];
  if (!lim || !BUYABLE.includes(plan)) throw new Error('Pick a plan to buy');
  const p = PERIODS[bill];
  if (!p) throw new Error('Pick monthly or yearly billing');
  const currency = currencyFor(country);
  const times = bill === 'yr' ? 10 : 1; // yearly: 12 months for the price of 10
  if (currency === 'INR') {
    const base = lim.priceInr * times;
    const total = withGst(base);
    return { plan, bill, currency, base, gst: total - base, total, amount: total * 100 };
  }
  const base = lim.priceUsd * times;
  return { plan, bill, currency, base, gst: 0, total: base, amount: base * 100 };
}

/** Every price the buy page can show, so its summary never does its own sums. */
export function quoteTable() {
  const out = {};
  for (const plan of BUYABLE) for (const bill of Object.keys(PERIODS)) for (const country of Object.keys(COUNTRIES)) {
    out[`${plan}:${bill}:${country}`] = quote({ plan, bill, country });
  }
  return out;
}

/** One line for people: "Starter Lite, monthly: ₹1,179 (₹999 + ₹180 GST)". */
export function describe(q) {
  const head = `${PLANS[q.plan].label}, ${PERIODS[q.bill].word}: ${money(q.total, q.currency)}`;
  return q.currency === 'INR' ? `${head} (${money(q.base, 'INR')} + ${money(q.gst, 'INR')} GST)` : `${head}, no GST`;
}

/** The cached Razorpay plan for this exact price (a price change makes a new plan). */
export function planKey(q) {
  return `${q.plan}:${q.bill}:${q.currency}:${q.amount}`;
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
      kind: 'charged', event: ev, subId: String(sub.id), currentEnd: Number(sub.current_end) || 0,
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
  BUY_PATH, BUYABLE, PERIODS, BILLING_KEYS, WEBHOOK_EVENTS, COUNTRIES, currencyFor, money, quote, quoteTable, describe, planKey,
  validGstin, cleanBuyer, buyerProblem, sigOk, checkoutSigOk, webhookAction, workspaceIdFrom, expiryAfter, expiryFromSub,
};
