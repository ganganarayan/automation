/**
 * Config operations (pure).
 *
 * Purpose:      Pure translation of a submitted config form into tenant_config
 *               writes/deletes, and the render helper for a module's stored
 *               choice. Kept free of settings/DB imports so it is unit-testable.
 * Responsibility: Pure logic only.
 * Dependencies: configManifest.
 *
 * Field rules (see configService):
 *   - secret: blank = leave unchanged; non-blank = set.
 *   - normal: blank = delete override; else set.
 *   - json: validated with JSON.parse.
 *   - module: 'true'/'false' = set; 'default' = delete.
 */
import { CONFIG_MANIFEST, moduleKey } from './configManifest.js';

/**
 * @param {string} app
 * @param {object} submitted - { settings: {key:value}, modules: {name: 'default'|'true'|'false'} }
 * @returns {{ sets: {key:string,value:string}[], dels: string[], errors: string[] }}
 */
export function buildSaveOps(app, submitted) {
  const manifest = CONFIG_MANIFEST[app];
  const sets = [];
  const dels = [];
  const errors = [];
  if (!manifest) {
    errors.push(`unknown app: ${app}`);
    return { sets, dels, errors };
  }

  const settings = submitted.settings || {};
  const modules = submitted.modules || {};

  for (const group of manifest.groups) {
    for (const field of group.fields) {
      if (!(field.key in settings)) continue;
      const raw = settings[field.key];
      const value = raw === undefined || raw === null ? '' : String(raw);
      const trimmed = value.trim();

      if (field.type === 'secret') {
        if (trimmed !== '') sets.push({ key: field.key, value });
        continue;
      }
      if (trimmed === '') {
        dels.push(field.key);
        continue;
      }
      if (field.type === 'json') {
        try {
          JSON.parse(trimmed);
        } catch {
          errors.push(`${field.label || field.key}: invalid JSON`);
          continue;
        }
      }
      sets.push({ key: field.key, value: trimmed });
    }
  }

  for (const mod of manifest.modules) {
    const choice = modules[mod.key];
    const mk = moduleKey(app, mod.key);
    if (choice === 'true' || choice === 'false') sets.push({ key: mk, value: choice });
    else dels.push(mk);
  }

  return { sets, dels, errors };
}

/** The stored module choice for rendering: 'true' | 'false' | 'default'. */
export function moduleChoice(configMap, app, name) {
  const v = configMap[moduleKey(app, name)];
  if (v === 'true' || v === 'false') return v;
  return 'default';
}

export default { buildSaveOps, moduleChoice };
