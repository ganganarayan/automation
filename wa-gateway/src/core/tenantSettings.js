/**
 * Tenant-aware settings resolver.
 *
 * Purpose:      Resolve a configuration value for a specific tenant, overlaying
 *               per-tenant overrides (tenant_config) on top of the environment
 *               defaults from the settings layer.
 * Responsibility:
 *               - For the "default" tenant, environment settings are the source
 *                 of truth (with tenant_config able to override).
 *               - For other tenants, tenant_config is authoritative, falling
 *                 back to the environment default.
 * Dependencies: settings, tenantConfigRepository.
 *
 * This is what makes per-brand configuration (Evolution instance names, sheet
 * ids, calendar link, audio banks, alert email, ...) movable into the database
 * later without any code change.
 */
import { settings } from '../settings/index.js';
import * as tenantConfig from '../repositories/tenantConfigRepository.js';

// Short in-process cache so hot paths don't hit the DB every message.
const CACHE_TTL_MS = 60_000;
const cache = new Map(); // tenantId -> { at, map }

async function loadOverrides(tenantId) {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.map;
  const map = await tenantConfig.getAll(tenantId);
  cache.set(tenantId, { at: Date.now(), map });
  return map;
}

/** Clear the override cache (used after writes/tests). */
export function invalidate(tenantId) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

/**
 * Resolve a single value by tenant_config key, with an env-derived fallback.
 * @param {string} tenantId
 * @param {string} key       - tenant_config key
 * @param {*} fallback       - default (usually from `settings`)
 */
export async function resolve(tenantId, key, fallback) {
  const overrides = await loadOverrides(tenantId);
  if (overrides[key] !== undefined && overrides[key] !== null && overrides[key] !== '') {
    return overrides[key];
  }
  return fallback;
}

/**
 * Build a resolved settings view for a tenant. The returned object mirrors the
 * env `settings` groups the modules need, with any tenant_config overrides
 * applied. Env acts as the fallback for the default tenant.
 */
export async function forTenant(tenantId = 'default') {
  const o = await loadOverrides(tenantId);
  const pick = (key, fallback) =>
    o[key] !== undefined && o[key] !== null && o[key] !== '' ? o[key] : fallback;

  return {
    tenantId,
    evolution: {
      baseUrl: pick('evolution_base_url', settings.evolution.baseUrl),
      apiKey: pick('evolution_api_key', settings.evolution.apiKey),
    },
    templates: {
      sheetId: pick('templates_sheet_id', settings.templates.sheetId),
      sheetTab: pick('templates_sheet_tab', settings.templates.sheetTab),
    },
    booking: {
      calendarLink: pick('calendar_link', settings.booking.calendarLink),
    },
    outreach: {
      audioBands: parseMaybeJson(pick('audio_bands', null)) || settings.outreach.audioBands,
    },
    alerts: {
      email: pick('alert_email', settings.alerts.email),
    },
  };
}

function parseMaybeJson(v) {
  if (!v || typeof v !== 'string') return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export default { resolve, forTenant, invalidate };
