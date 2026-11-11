/**
 * Billing data access: Razorpay plans, checkouts and payments.
 *
 * Purpose:      The only place billing SQL runs (migrations/029_billing.sql).
 * Dependencies: core/db.
 */
import { query } from '../core/db.js';

/** The Razorpay plan id cached for a price key, or null. */
export async function planId(key) {
  const { rows } = await query('SELECT razorpay_plan_id FROM billing_plans WHERE key = $1', [key]);
  return rows[0] ? rows[0].razorpay_plan_id : null;
}

export async function savePlanId(key, id) {
  await query('INSERT INTO billing_plans (key, razorpay_plan_id) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, id]);
}

/** A checkout started from the buy page (id = the Razorpay subscription id). */
export async function createCheckout(c) {
  await query(
    `INSERT INTO checkouts (id, plan, bill, currency, amount, base, gst, name, business, email, phone, country, gstin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [c.id, c.plan, c.bill, c.currency, c.amount, c.base, c.gst, c.name || null, c.business || null, c.email, c.phone || null, c.country, c.gstin || null],
  );
}

export async function findCheckout(id) {
  const { rows } = await query('SELECT * FROM checkouts WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Take a paid checkout to make its workspace; null if someone else already did (or is). */
export async function claim(id, paymentId = '') {
  const { rows } = await query(
    `UPDATE checkouts SET status = 'provisioning', paid_at = COALESCE(paid_at, now()), payment_id = COALESCE(NULLIF($2, ''), payment_id)
      WHERE id = $1 AND status = 'created' RETURNING *`,
    [id, paymentId],
  );
  return rows[0] || null;
}

/** Making the workspace failed: let the next confirm or webhook try again. */
export async function release(id) {
  await query("UPDATE checkouts SET status = 'created' WHERE id = $1 AND status = 'provisioning'", [id]);
}

export async function markProvisioned(id, tenantId) {
  await query("UPDATE checkouts SET status = 'provisioned', tenant_id = $2 WHERE id = $1", [id, tenantId]);
}

export async function setTenantBilling(tenantId, subId, currency) {
  await query('UPDATE tenants SET billing_sub_id = $2, billing_currency = $3 WHERE id = $1', [tenantId, subId, currency]);
}

/** Move a tenant's expiry later (never earlier). */
export async function extendTenant(tenantId, expiresAt) {
  await query('UPDATE tenants SET expires_at = $2 WHERE id = $1 AND (expires_at IS NULL OR expires_at < $2)', [tenantId, expiresAt]);
}

/** A charge, once (the confirm call and the webhook may both report it). */
export async function logPayment(p) {
  await query(
    `INSERT INTO billing_payments (payment_id, sub_id, tenant_id, currency, amount, base, gst, gstin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (payment_id) DO NOTHING`,
    [p.paymentId, p.subId, p.tenantId || null, p.currency, p.amount, p.base, p.gst, p.gstin || null],
  );
}

/** A new one-time password for a buyer who has not signed in yet. */
export async function resetFirstPassword(email, passwordHash) {
  const { rowCount } = await query(
    'UPDATE users SET password_hash = $2 WHERE email = $1 AND must_change_password = true',
    [String(email).trim().toLowerCase(), passwordHash],
  );
  return rowCount > 0;
}

export default { planId, savePlanId, createCheckout, findCheckout, claim, release, markProvisioned, setTenantBilling, extendTenant, logPayment, resetFirstPassword };
