/**
 * Configuration service.
 *
 * Purpose:      Back the tenant-scoped config UI: load a tenant's current
 *               overrides and translate a submitted form into tenant_config
 *               writes/deletes.
 * Responsibility:
 *               - buildSaveOps: pure translation of a submitted app form into
 *                 {sets, dels, errors}, applying the field rules below.
 *               - save: apply those ops and invalidate the tenant cache.
 *               - load: current tenant_config map for rendering.
 * Dependencies: configManifest, tenantConfigRepository, tenantSettings.
 *
 * Field rules:
 *   - secret field: blank input = leave unchanged (never echoed); non-blank = set.
 *   - normal field: blank = delete override (revert to env default); else set.
 *   - json field: validated with JSON.parse before saving.
 *   - module toggle: 'true'/'false' = set; 'default' = delete (use env flag).
 */
import * as tenantConfig from '../repositories/tenantConfigRepository.js';
import * as tenantSettings from '../core/tenantSettings.js';
import { buildSaveOps, moduleChoice } from './configOps.js';
import { fieldByKey } from './configManifest.js';

/**
 * Apply a submitted app form for a tenant.
 * @returns {{ saved: number, errors: string[] }}
 */
export async function save(tenantId, app, submitted) {
  const { sets, dels, errors } = buildSaveOps(app, submitted);
  if (errors.length) return { saved: 0, errors };

  for (const { key, value } of sets) await tenantConfig.set(tenantId, key, value);
  for (const key of dels) await tenantConfig.del(tenantId, key);

  tenantSettings.invalidate(tenantId); // content-engine picks up changes immediately
  return { saved: sets.length + dels.length, errors: [] };
}

/** Current tenant_config map for a tenant (for rendering). */
export async function load(tenantId) {
  return tenantConfig.getAll(tenantId);
}

export { fieldByKey, buildSaveOps, moduleChoice };
export default { buildSaveOps, save, load, moduleChoice, fieldByKey };
