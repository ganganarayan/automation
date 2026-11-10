/**
 * Usage meter: one paid call that belongs to no run, onto the usage ledger.
 *
 * Purpose:      Runs keep their costs on their steps. A paid call outside a run
 *               (image gate, research, sheet refill, the older image and video
 *               jobs) is written here so the owner's cost report sees it.
 * Responsibility: meter(providers, entry, source). Never throws, never waits.
 * Dependencies: usageRepository (loaded on use: it pulls in the database).
 *
 * The key owner is stored as it was at the call, so a later key change does not
 * move old spend on or off the owner's bill.
 */
export function ownerOf(resolved, provider) {
  return ((resolved && resolved.keyOwners) || {})[provider] === 'tenant' ? 'tenant' : 'platform';
}

export function meter(providers, entry, source = '') {
  if (!entry || !(Number(entry.costUsd) > 0)) return;
  const r = (providers && providers.resolved) || {};
  import('../repositories/usageRepository.js')
    .then((usage) => usage.record({
      tenantId: r.tenantId || 'default',
      provider: entry.provider,
      model: entry.model || null,
      unit: entry.unit || null,
      quantity: Number(entry.quantity) || 0,
      costUsd: Number(entry.costUsd) || 0,
      source,
      keyOwner: ownerOf(r, entry.provider),
    }))
    .catch(() => {});
}

export default { meter, ownerOf };
