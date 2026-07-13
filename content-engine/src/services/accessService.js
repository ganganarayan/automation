/**
 * Access service.
 *
 * Purpose:      Single source of truth for guarding the dashboard and config
 *               pages. Access is protected by a UI-settable key stored in the
 *               database (not an env var); an ADMIN_KEY env value is honored as
 *               a fallback. If neither is set the pages are open.
 * Responsibility: resolve the required key and check a request against it.
 * Dependencies: tenantConfigRepository, settings.
 *
 * Password/login is not implemented yet; this key is the interim guard.
 */
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import { settings } from '../settings/index.js';

export const ACCESS_KEY_STORE = { tenant: 'default', key: 'access_key' };

/** The currently-required access key ('' means open). */
export async function requiredKey() {
  let dbKey = null;
  try {
    dbKey = await tenantConfig.get(ACCESS_KEY_STORE.tenant, ACCESS_KEY_STORE.key);
  } catch {
    dbKey = null;
  }
  return dbKey || settings.auth.adminKey || '';
}

/** True if the request supplies the required key (or none is required). */
export async function keyOk(req) {
  const required = await requiredKey();
  if (!required) return true;
  const provided = req.query.key || req.headers['x-admin-key'] || (req.body && req.body.key);
  return provided === required;
}

export default { requiredKey, keyOk, ACCESS_KEY_STORE };
