/**
 * Plan limits (pure).
 *
 * Purpose:      The plans from docs/pricing-plan.md as numbers the app
 *               enforces, plus custom (no limits: the owner, deals).
 * Responsibility: PLANS, limitsFor, limitsForTenant, monthlyPrice, overLimit,
 *               planLabel, tenantLive.
 * Dependencies: none.
 *
 * null means unlimited. Posts are counted one per post (all its channels),
 * per IST month. A client of an agency uses its agency's plan, and posts and AI
 * videos are counted across the agency and all its clients (planService).
 */

export const PLANS = {
  // Always-On Brand: the one plan on sale. Priced per funnel (brand); every
  // funnel costs the same (about Rs 1,188 a month to make 30 posts for 10
  // channels), so a cheaper extra funnel would fall under 50% margin. Limits
  // below are for one funnel; limitsForTenant scales them by funnels bought.
  brand: {
    label: 'Always-On Brand', priceInr: 3199, priceUsd: 37, funnels: 1, channels: 10, posts: 30, aiVideos: 0, users: 1, clients: 0,
    perUnit: 'funnel', unit: { priceInr: 3199, priceUsd: 37, funnels: 1, channels: 10, posts: 30, aiVideos: 0, clients: 0 },
  },
  // Solo: the lean build for 1 funnel and 5 channels, offered only to someone
  // cancelling (Plan page), never on the pricing page.
  solo: { label: 'Solo', priceInr: 1699, priceUsd: 20, funnels: 1, channels: 5, posts: 30, aiVideos: 0, users: 1, clients: 0, lean: true },
  // Older plans: kept for workspaces already on them; no longer sold.
  // Starter Lite: the lean build (lean: true). One 9:16 picture per post with the
  // 4:5 cut from it, and ElevenLabs' low-cost Flash voice, so 15 posts cost little.
  lite: { label: 'Starter Lite', priceInr: 999, priceUsd: 12, funnels: 1, channels: 5, posts: 15, aiVideos: 0, users: 1, clients: 0, lean: true },
  starter: { label: 'Starter', priceInr: 2799, priceUsd: 32, funnels: 1, channels: 5, posts: 30, aiVideos: 0, users: 1, clients: 0 },
  growth: { label: 'Growth', priceInr: 10499, priceUsd: 119, funnels: 3, channels: 6, posts: 90, aiVideos: 4, users: 3, clients: 0 },
  // Agency: 10 clients, each its own workspace and logins, no cap on funnels or
  // channels per client; posts are counted across the agency and its clients.
  // Sold per client since 11-11-2026 (unit): the Always-On Brand promise per
  // client at 25% more. A workspace with no units bought keeps these flat limits.
  agency: {
    label: 'Agency', priceInr: 14999, priceUsd: 169, funnels: null, channels: null, posts: 300, aiVideos: null, users: 10, clients: 10,
    perUnit: 'client', unit: { priceInr: 3999, priceUsd: 47, funnels: null, channels: 10, posts: 30, aiVideos: 0, clients: 1 },
  },
  custom: { label: 'Custom (no limits)', priceInr: null, priceUsd: null, funnels: null, channels: null, posts: null, aiVideos: null, users: null, clients: null },
};

export const PLAN_IDS = Object.keys(PLANS);

/** The ElevenLabs model a lean plan voices with (about half the multilingual price). */
export const LEAN_VOICE_MODEL = 'eleven_flash_v2_5';
/** The default ElevenLabs model. */
export const FULL_VOICE_MODEL = 'eleven_multilingual_v2';

/** Does this plan use the lean build? */
export function isLean(plan) {
  return !!limitsFor(plan).lean;
}

/** Every rupee price a person reads is shown before GST, which is added on top. */
export const GST_NOTE = '+ GST';
/** GST on software in India. */
export const GST_RATE = 0.18;
/** A rupee price with GST added, to the rupee. */
export function withGst(inr) {
  return Math.round((Number(inr) || 0) * (1 + GST_RATE));
}
/**
 * Add-ons: 30 more posts, one more AI video. Rupees before GST; dollars outside India.
 * Every price here and in PLANS keeps at least 50% after Razorpay's fee and the
 * provider cost, yearly billing included (docs/pricing-plan.md, Margins).
 */
export const EXTRAS = { posts30: { inr: 2499, usd: 29 }, aiVideo: { inr: 499, usd: 6 }, user: { inr: 100, usd: 1.5 } };

/** Plans sold per unit (funnel or client) with extra users on top. */
export const UNIT_PLANS = ['brand', 'agency'];
/** Most funnels or clients one purchase can cover; more is a Custom deal. */
export const MAX_UNITS = 50;
/** Most extra users one purchase can add. */
export const MAX_EXTRA_USERS = 50;

/** Whole number in [lo, hi], else lo. */
function count(n, lo, hi) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= lo && v <= hi ? v : lo;
}

/**
 * A workspace's limits: the plan's, scaled by the funnels (or clients) bought
 * and the extra users. A tenant without units keeps the plan's flat limits.
 */
export function limitsForTenant(plan, { units = null, extraUsers = 0 } = {}) {
  const lim = limitsFor(plan);
  const extra = count(extraUsers, 0, 10000);
  const bought = units === null || units === undefined || units === '' ? 0 : count(units, 0, 10000);
  if (!lim.unit || !bought) return extra && lim.users !== null ? { ...lim, users: lim.users + extra } : lim;
  const u = lim.unit;
  const times = (v) => (v === null ? null : v * bought);
  return {
    ...lim,
    units: bought,
    funnels: times(u.funnels),
    channels: u.channels,
    posts: times(u.posts),
    aiVideos: times(u.aiVideos),
    clients: times(u.clients),
    // Agency: one login per client plus the agency's own.
    users: (lim.perUnit === 'client' ? bought + 1 : 1) + extra,
  };
}

/** A month's price before GST: units x plan price + extra users. */
export function monthlyPrice(plan, { units = 1, extraUsers = 0 } = {}, currency = 'INR') {
  const lim = limitsFor(plan);
  const src = lim.unit || lim;
  const usd = currency === 'USD';
  const unit = usd ? src.priceUsd : src.priceInr;
  if (unit === null || unit === undefined) return null;
  const n = lim.unit ? count(units, 1, MAX_UNITS) : 1;
  const u = count(extraUsers, 0, MAX_EXTRA_USERS);
  return Math.round((unit * n + (usd ? EXTRAS.user.usd : EXTRAS.user.inr) * u) * 100) / 100;
}

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
export function overLimit(plan, what, used = 0, adding = 1, limits = null) {
  const lim = limits || limitsFor(plan);
  const max = lim[what];
  if (max === null || max === undefined) return '';
  if ((Number(used) || 0) + (Number(adding) || 0) <= max) return '';
  return `Your ${lim.label} plan allows ${WORDS[what] ? WORDS[what](max) : `${max} ${what}`}.${lim.perUnit === 'funnel' && what !== 'users' ? ' Add a funnel to your plan for more.' : ' Ask the owner for a bigger plan.'}`;
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

export default { USD_INR, PLANS, PLAN_IDS, UNIT_PLANS, MAX_UNITS, MAX_EXTRA_USERS, limitsForTenant, monthlyPrice, LEAN_VOICE_MODEL, FULL_VOICE_MODEL, GST_NOTE, GST_RATE, EXTRAS, withGst, isLean, limitsFor, planLabel, overLimit, tenantLive, validTenantId };
