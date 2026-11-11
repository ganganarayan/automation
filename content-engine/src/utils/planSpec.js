/**
 * Plan limits (pure).
 *
 * Purpose:      The three paid plans from docs/pricing-plan.md as numbers the
 *               app enforces, plus custom (no limits: the owner, deals).
 * Responsibility: PLANS, limitsFor, overLimit, planLabel, tenantLive.
 * Dependencies: none.
 *
 * null means unlimited. Posts are counted one per post (all its channels),
 * per IST month. A client of an agency uses its agency's plan, and posts and AI
 * videos are counted across the agency and all its clients (planService).
 */

export const PLANS = {
  starter: { label: 'Starter', priceInr: 2499, funnels: 1, channels: 5, posts: 30, aiVideos: 0, users: 1, clients: 0 },
  growth: { label: 'Growth', priceInr: 8999, funnels: 3, channels: 6, posts: 90, aiVideos: 4, users: 3, clients: 0 },
  // Agency: 10 clients, each its own workspace and logins, no cap on funnels or
  // channels per client; posts are counted across the agency and its clients.
  agency: { label: 'Agency', priceInr: 14999, funnels: null, channels: null, posts: 300, aiVideos: null, users: 10, clients: 10 },
  custom: { label: 'Custom (no limits)', priceInr: null, funnels: null, channels: null, posts: null, aiVideos: null, users: null, clients: null },
};

export const PLAN_IDS = Object.keys(PLANS);

/** Rupees to the dollar for the cost report (docs/pricing-plan.md). */
export const USD_INR = 88;

export function limitsFor(plan) {
  return PLANS[String(plan || '').toLowerCase()] || PLANS.custom;
}

export function planLabel(plan) {
  return limitsFor(plan).label;
}

const WORDS = {
  funnels: (n) => `${n} funnel${n === 1 ? '' : 's'}`,
  channels: (n) => `${n} channel${n === 1 ? '' : 's'} per funnel`,
  posts: (n) => `${n} posts a month`,
  aiVideos: (n) => (n === 0 ? 'no AI videos' : `${n} AI video${n === 1 ? '' : 's'} a month`),
  users: (n) => `${n} user${n === 1 ? '' : 's'}`,
  clients: (n) => (n === 0 ? 'no clients' : `${n} client${n === 1 ? '' : 's'}`),
};

/**
 * Would `used + adding` go over the plan? Returns '' when fine, else the reason
 * a person reads ("Your Starter plan allows 1 funnel.").
 */
export function overLimit(plan, what, used = 0, adding = 1) {
  const lim = limitsFor(plan);
  const max = lim[what];
  if (max === null || max === undefined) return '';
  if ((Number(used) || 0) + (Number(adding) || 0) <= max) return '';
  return `Your ${lim.label} plan allows ${WORDS[what] ? WORDS[what](max) : `${max} ${what}`}. Ask the owner for a bigger plan.`;
}

/**
 * Is a tenant live (may act and run jobs)? Active and not past its expiry.
 * @returns {{ live: boolean, reason: string }}
 */
export function tenantLive(tenant, now = new Date()) {
  if (!tenant) return { live: false, reason: 'no such workspace' };
  if (tenant.status && tenant.status !== 'active') return { live: false, reason: `this workspace is ${tenant.status}` };
  if (tenant.expires_at && new Date(tenant.expires_at) <= now) return { live: false, reason: 'expired' };
  return { live: true, reason: '' };
}

/** A tenant id people can type: lower-case letters, digits and dashes. */
export function validTenantId(id) {
  return /^[a-z0-9][a-z0-9-]{1,30}$/.test(String(id || '')) && !String(id).includes(':');
}

export default { USD_INR, PLANS, PLAN_IDS, limitsFor, planLabel, overLimit, tenantLive, validTenantId };
