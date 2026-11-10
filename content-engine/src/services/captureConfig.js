/**
 * Comment-capture config resolver.
 *
 * Purpose:      Read the Meta / capture settings a tenant saved in the app
 *               (tenant_config): app secret, verify token, page tokens, our own
 *               account IDs, extra abuse words. Nothing here is an env secret.
 * Responsibility: Read + shape config; no network, no business logic.
 * Dependencies: tenantConfigRepository, captureSpec (word-list parsing).
 */
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { parseWordList } from '../utils/captureSpec.js';
import { idOwners, claimedIds } from '../utils/metaRoute.js';

function json(value, fallback) {
  if (!value) return fallback;
  try {
    const v = JSON.parse(value);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/** Resolve the capture config for a tenant. */
export async function forTenant(tenantId = 'default') {
  const cfg = await tenantConfig.getAll(tenantId).catch(() => ({}));
  const pageTokens = json(cfg.meta_page_tokens, {});
  const selfIds = json(cfg.meta_self_ids, []);
  return {
    appId: cfg.meta_app_id || '',
    appSecret: cfg.meta_app_secret || '',
    verifyToken: cfg.meta_verify_token || '',
    pageTokens: pageTokens && typeof pageTokens === 'object' ? pageTokens : {},
    selfIds: (Array.isArray(selfIds) ? selfIds : []).map(String),
    abuseWords: parseWordList(cfg.capture_abuse_words),
  };
}

/** Pick the access token for a given page/IG id (used by the senders in step 4). */
export function tokenFor(captureCfg, id) {
  if (!captureCfg || !captureCfg.pageTokens) return '';
  return captureCfg.pageTokens[String(id)] || '';
}

/**
 * Which live tenant owns each Page / IG account id (cached a minute), for the
 * owner's shared Meta webhook. Fails to an empty map: everything stays the owner's.
 */
let ownersHit = null;
export async function accountOwners() {
  if (ownersHit && Date.now() - ownersHit.at < 60 * 1000) return ownersHit.map;
  let map = new Map();
  try {
    const tenantRepo = await import('../repositories/tenantRepository.js');
    const list = [];
    for (const tenantId of await tenantRepo.activeIds()) list.push({ tenantId, ids: claimedIds(await forTenant(tenantId)) });
    map = idOwners(list);
  } catch { /* keep empty */ }
  ownersHit = { at: Date.now(), map };
  return map;
}

export function forgetOwners() { ownersHit = null; }

export default { forTenant, tokenFor, accountOwners, forgetOwners };
