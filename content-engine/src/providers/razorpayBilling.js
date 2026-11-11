/**
 * Razorpay REST client for subscriptions (the owner's account).
 *
 * Purpose:      Make plans and subscriptions, and stop one at the end of its
 *               period. Rupee and dollar plans go through the same account;
 *               dollars need International payments switched on in Razorpay.
 * Responsibility: HTTP only. Keys come from the caller (billingService reads
 *               them from the owner's settings).
 * Dependencies: global fetch.
 */
const API = 'https://api.razorpay.com/v1';

async function call({ keyId, keySecret }, method, path, body) {
  if (!keyId || !keySecret) throw new Error('Razorpay keys are not set (Plan page, Payments)');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = (json && json.error && (json.error.description || json.error.code)) || `HTTP ${res.status}`;
    throw new Error(`Razorpay: ${why}`);
  }
  return json;
}

/** A plan: { period: 'monthly'|'yearly', item: { name, amount, currency, description } }. */
export function createPlan(keys, { period, item }) {
  return call(keys, 'POST', '/plans', { period, interval: 1, item });
}

/** A subscription on a plan: { plan_id, total_count, customer_notify, notes }. */
export function createSubscription(keys, body) {
  return call(keys, 'POST', '/subscriptions', body);
}

/** Stop renewing at the end of the period already paid for. */
export function cancelSubscription(keys, id) {
  return call(keys, 'POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 1 });
}

/**
 * Move a subscription to another plan from its next renewal. Razorpay allows
 * this for card mandates; UPI and other mandates refuse it (the error says so).
 */
export function changePlan(keys, id, planId) {
  return call(keys, 'PATCH', `/subscriptions/${encodeURIComponent(id)}`, { plan_id: planId, quantity: 1, schedule_change_at: 'cycle_end', customer_notify: 1 });
}

export default { createPlan, createSubscription, cancelSubscription, changePlan };
