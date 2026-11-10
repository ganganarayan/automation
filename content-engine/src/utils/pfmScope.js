/**
 * Post for Me tenant scope (pure).
 *
 * Purpose:      Many tenants share the owner's one Post for Me account. Every
 *               account a tenant connects under that key carries external_id
 *               "<tenantId>" (or "<tenantId>:<anything>"), so the app can tell
 *               whose account is whose. This module is the one rule for that.
 * Responsibility:
 *               - scopeFor({ tenantId, ownKey, ownerKey, ownerTenant, otherTenants })
 *               - ownsAccount(scope, account) / filterAccounts(scope, list)
 *               - connectExternalId(scope, requested)
 *               - ownsPost(scope, post)
 *               - hookTenant / webhookMayAct (the shared key's one webhook)
 *               - usageMonth / planShare (the shared plan's bill split)
 * Dependencies: none.
 *
 * A null scope means the tenant uses a Post for Me key of its own: the whole
 * account is its own, nothing is filtered.
 *
 * The owner tenant (the one the shared key is stored on) owns every account that
 * does not belong to another tenant, so accounts connected before this change
 * (no external_id) stay the owner's. When the tenant list is unknown, the owner
 * owns only blank and its own external_ids (fail closed).
 */

export const OWNER_TENANT = 'default';

/** The tenant an external_id belongs to: "acme" and "acme:x" are both "acme". */
export function tenantOfExternalId(ext) {
  return String(ext == null ? '' : ext).trim().split(':')[0];
}

/**
 * The scope a tenant works in, or null when it has a key of its own.
 * @param {object} a
 * @param {string} a.tenantId
 * @param {string} [a.ownKey]       - the tenant's own postforme_api_key ('' = none)
 * @param {string} [a.ownerKey]     - the owner's shared key
 * @param {string} [a.ownerTenant]  - where the shared key lives
 * @param {string[]|null} [a.otherTenants] - every tenant id except the owner (null = unknown)
 */
export function scopeFor({ tenantId, ownKey = '', ownerKey = '', ownerTenant = OWNER_TENANT, otherTenants = null }) {
  const own = String(ownKey || '').trim();
  const shared = String(ownerKey || '').trim();
  const id = String(tenantId || OWNER_TENANT);
  if (id === ownerTenant) {
    return { tenantId: id, owner: true, keyTenant: ownerTenant, others: Array.isArray(otherTenants) ? otherTenants.map(String).filter((t) => t && t !== ownerTenant) : null };
  }
  if (own && own !== shared) return null;
  if (!shared && !own) return null;
  return { tenantId: id, owner: false, keyTenant: ownerTenant, others: null };
}

/** Does this account belong to the scope's tenant? */
export function ownsAccount(scope, account) {
  if (!scope) return true;
  const t = tenantOfExternalId(account && account.external_id);
  if (scope.owner) {
    if (!t || t === scope.tenantId) return true;
    if (!Array.isArray(scope.others)) return false;
    return !scope.others.includes(t);
  }
  return t === scope.tenantId;
}

export function filterAccounts(scope, list) {
  return (Array.isArray(list) ? list : []).filter((a) => ownsAccount(scope, a));
}

/**
 * The external_id a connect link carries. A tenant's own "<tenantId>:x"
 * (an account's reconnect) is kept; anything else becomes "<tenantId>".
 */
export function connectExternalId(scope, requested = '') {
  const req = String(requested || '').trim();
  if (!scope) return req;
  if (req && ownsAccount(scope, { external_id: req })) return req;
  return scope.tenantId;
}

/**
 * Is this post the tenant's? The app tags each post it makes with the tenant's
 * id; an untagged (older) post is judged by the app's own records, which are
 * already per tenant.
 */
export function ownsPost(scope, post) {
  if (!scope || !post) return true;
  const ext = post.external_id;
  if (!ext) return true;
  return ownsAccount(scope, { external_id: ext });
}

/** Which tenant's webhook a key's events arrive on (the key owner's when shared). */
export function hookTenant(tenantId, scope) {
  return scope && !scope.owner ? scope.keyTenant : tenantId;
}

/**
 * May a webhook call that arrived for hookTenantId act on this first-comment
 * job? Only the job's own tenant, or the shared key's owner webhook for a tenant
 * that posts on the shared key. Never any other tenant.
 */
export function webhookMayAct({ hookTenantId, rowTenantId, rowScope }) {
  if (!rowTenantId) return false;
  if (String(rowTenantId) === String(hookTenantId)) return true;
  return !!rowScope && !rowScope.owner && String(rowScope.keyTenant) === String(hookTenantId);
}

/** "YYYY-MM" of an instant, in IST (fixed +05:30). */
export function usageMonth(at) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 7);
}

/** "YYYY-MM" to "MM-YYYY" for people. */
export function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  return m ? `${m[2]}-${m[1]}` : String(ym || '');
}

/**
 * Split the shared plan's monthly bill by each tenant's successful posts.
 * Plan: $10 a month covers 1,000 successful posts for the whole account.
 * @param {Record<string, number>} counts - tenantId -> successful posts this month
 * @returns {{ total, limit, priceUsd, overLimit, share: Record<string,{posts, pct, usd}> }}
 */
export function planShare(counts = {}, { limit = 1000, priceUsd = 10 } = {}) {
  const total = Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0);
  const share = {};
  for (const [t, n] of Object.entries(counts)) {
    const posts = Number(n) || 0;
    const pct = total ? posts / total : 0;
    share[t] = { posts, pct: Math.round(pct * 1000) / 10, usd: Math.round(pct * priceUsd * 100) / 100 };
  }
  return { total, limit, priceUsd, overLimit: total > limit, share };
}

export default { hookTenant, webhookMayAct, OWNER_TENANT, tenantOfExternalId, scopeFor, ownsAccount, filterAccounts, connectExternalId, ownsPost, usageMonth, monthLabel, planShare };
