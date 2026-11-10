/**
 * Meta webhook routing (pure).
 *
 * Purpose:      One Meta app (the owner's) sends every tenant's comments and DM
 *               replies to one webhook URL. Each delivery entry carries the Page
 *               or Instagram account id it is about; that id says whose it is.
 * Responsibility: idOwners (id -> tenant), splitByTenant (one body per tenant).
 * Dependencies: none.
 *
 * A tenant claims an id by putting it in its own account ids or page tokens
 * (Comment capture settings). An id no tenant claims, or one two tenants both
 * claim, stays with the tenant the request came in for (the owner, on the plain URL).
 */

/**
 * @param {Array<{ tenantId: string, ids: string[] }>} list
 * @returns {Map<string, string|null>} id -> tenant, or null when claimed twice
 */
export function idOwners(list = []) {
  const out = new Map();
  for (const { tenantId, ids } of list || []) {
    for (const raw of ids || []) {
      const id = String(raw ?? '').trim();
      if (!id) continue;
      if (out.has(id) && out.get(id) !== String(tenantId)) out.set(id, null);
      else out.set(id, String(tenantId));
    }
  }
  return out;
}

/**
 * Split a Meta delivery into one body per tenant, keeping the body's shape.
 * @returns {Record<string, object>} tenantId -> { ...body, entry: [...] }
 */
export function splitByTenant(body, owners = new Map(), fallback = 'default') {
  if (!body || !Array.isArray(body.entry)) return { [fallback]: body };
  const groups = {};
  for (const entry of body.entry) {
    const id = String(entry?.id ?? '');
    const t = (id && owners.get(id)) || fallback;
    (groups[t] = groups[t] || []).push(entry);
  }
  const out = {};
  for (const [t, entry] of Object.entries(groups)) out[t] = { ...body, entry };
  return out;
}

/** The ids a tenant's capture config claims: its own account ids and page-token ids. */
export function claimedIds(cfg = {}) {
  return [...new Set([...(cfg.selfIds || []), ...Object.keys(cfg.pageTokens || {})].map(String).filter(Boolean))];
}

export default { idOwners, splitByTenant, claimedIds };
