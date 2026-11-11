/**
 * Margins (pure).
 *
 * Purpose:      The owner's rule: no plan on sale keeps less than 50% of its
 *               price before GST, after Razorpay's fee and the provider cost,
 *               monthly or yearly (docs/pricing-plan.md, Margins).
 * Responsibility: UNIT_COST_INR, FEE_KEEP, lowestMargin.
 * Dependencies: utils/planSpec (pure).
 */
import { monthlyPrice, USD_INR } from './planSpec.js';

/** Provider cost a month per unit (funnel, client or Solo workspace), rupees. */
export const UNIT_COST_INR = { brand: 1188, agency: 1188, solo: 660 };
/** What stays after Razorpay's fee with GST on the fee: India, international cards. */
export const FEE_KEEP = { INR: 0.972152, USD: 0.9646 };

/** Lowest margin of a plan over monthly and yearly billing in one currency. */
export function lowestMargin(plan, currency) {
  const price = monthlyPrice(plan, { units: 1 }, currency);
  const cost = currency === 'INR' ? UNIT_COST_INR[plan] : UNIT_COST_INR[plan] / USD_INR;
  const m = (month) => (month * FEE_KEEP[currency] - cost) / month;
  return Math.min(m(price), m((price * 10) / 12));
}

export default { UNIT_COST_INR, FEE_KEEP, lowestMargin };
